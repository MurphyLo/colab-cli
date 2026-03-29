#!/usr/bin/env node

import net from 'net';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { randomUUID, UUID } from 'crypto';
import { AuthManager } from '../auth/auth-manager.js';
import { AuthType } from '../colab/api.js';
import { ColabClient } from '../colab/client.js';
import { KernelConnection } from '../jupyter/kernel-connection.js';
import { KeepAlive } from '../runtime/keep-alive.js';
import { ConnectionRefresher } from '../runtime/connection-refresher.js';
import { getStoredServer } from '../runtime/storage.js';
import { COLAB_API_DOMAIN, COLAB_GAPI_DOMAIN, CONFIG_DIR } from '../config.js';
import type { ClientMessage, ServerMessage } from './protocol.js';
import { encode } from './protocol.js';
import { ExecutionStore } from './execution-store.js';

const serverId = process.argv[2] as UUID;
if (!serverId) {
  console.error('Usage: server.js <server-id>');
  process.exit(1);
}

const SOCKET_PATH = path.join(CONFIG_DIR, `daemon-${serverId}.sock`);
const PID_FILE = path.join(CONFIG_DIR, `daemon-${serverId}.pid`);

function cleanupFiles() {
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  try { fs.unlinkSync(PID_FILE); } catch {}
}

function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.connect(socketPath, () => {
      client.destroy();
      resolve(true);
    });
    client.on('error', () => resolve(false));
  });
}

interface ActiveExecution {
  execId: number;
  attachedSocket?: net.Socket;
  pendingAuthRequests: Map<string, (error?: string) => void>;
  pendingStdinResolve?: (value: string | undefined) => void;
}

async function main() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  // Defense-in-depth: exit if another daemon is already serving this socket
  if (await isSocketAlive(SOCKET_PATH)) {
    console.log('Another daemon is already serving, exiting');
    process.exit(0);
  }

  fs.writeFileSync(PID_FILE, String(process.pid));

  // Clean stale socket
  try { fs.unlinkSync(SOCKET_PATH); } catch {}

  // Initialize auth
  const authManager = new AuthManager();
  await authManager.initialize();
  if (!authManager.isLoggedIn()) {
    console.error('Not logged in');
    cleanupFiles();
    process.exit(1);
  }

  // Load server info
  const server = getStoredServer(serverId);
  if (!server) {
    console.error('Server not found:', serverId);
    cleanupFiles();
    process.exit(1);
  }

  // Create colab client
  const colabClient = new ColabClient(
    new URL(COLAB_API_DOMAIN),
    new URL(COLAB_GAPI_DOMAIN),
    () => authManager.getAccessToken(),
    () => authManager.logout(),
  );

  // Start background services
  const keepAlive = new KeepAlive(colabClient, server.endpoint);
  keepAlive.start();

  const refresher = new ConnectionRefresher(
    colabClient,
    server.id,
    server.endpoint,
    server.token,
    server.proxyUrl,
    server.tokenExpiry,
  );
  refresher.start();

  const store = new ExecutionStore(serverId);
  const execState: { activeExecution?: ActiveExecution } = {};

  const requestEphemeralAuth = async (authType: AuthType): Promise<void> => {
    const active = execState.activeExecution;
    if (!active?.attachedSocket || active.attachedSocket.destroyed) {
      throw new Error(
        'No CLI session attached to complete Google Drive authorization',
      );
    }

    const requestId = randomUUID();
    const result = await new Promise<string | undefined>((resolve) => {
      active.pendingAuthRequests.set(requestId, resolve);
      if (active.attachedSocket!.destroyed) {
        active.pendingAuthRequests.delete(requestId);
        resolve('CLI session closed before authorization completed');
        return;
      }
      active.attachedSocket!.write(
        encode({ type: 'auth_required', requestId, authType }),
      );
    });

    if (result) {
      throw new Error(result);
    }
  };

  // Create kernel (connect later, after socket is listening)
  const kernel = new KernelConnection(
    () => refresher.proxyUrl,
    () => refresher.token,
    colabClient,
    server.endpoint,
    requestEphemeralAuth,
  );

  // Begin kernel connection (may be slow on cold-start GPU runtimes).
  // Store the promise so exec handlers can await it instead of failing early.
  console.log('Connecting to kernel...');
  const kernelReady = kernel.connect().then(() => {
    console.log('Kernel connected');
  });

  /** Run execution and route outputs to store + attached socket. */
  async function runExecution(execId: number, code: string): Promise<void> {
    try {
      await kernelReady;
      if (!kernel.isConnected) {
        store.fail(execId, 'Kernel not connected');
        const active = execState.activeExecution;
        if (active?.execId === execId && active.attachedSocket && !active.attachedSocket.destroyed) {
          active.attachedSocket.write(encode({ type: 'exec_error', message: 'Kernel not connected' }));
        }
        return;
      }
      const outputs = await kernel.execute(code);
      for await (const output of outputs) {
        const active = execState.activeExecution;
        if (output.type === 'input_request') {
          store.setPendingInput(execId, output.prompt, output.password);
          if (active?.execId === execId && active.attachedSocket && !active.attachedSocket.destroyed) {
            // Forward stdin request to attached client
            active.attachedSocket.write(
              encode({ type: 'input_request', prompt: output.prompt, password: output.password }),
            );
            const value = await new Promise<string | undefined>((resolve) => {
              active.pendingStdinResolve = resolve;
            });
            active.pendingStdinResolve = undefined;
            store.clearPendingInput(execId);
            if (value !== undefined) {
              kernel.sendStdinReply(value);
            }
            // undefined means interrupted — skip reply, continue consuming outputs
          } else {
            // No client attached — send empty string to unblock kernel
            store.clearPendingInput(execId);
            kernel.sendStdinReply('');
            store.appendOutput(execId, {
              type: 'stream',
              name: 'stderr',
              text: '[colab-cli] stdin requested but no client attached; sent empty input\n',
            });
            // Also forward the synthetic warning to attached client if one appeared in the meantime
          }
          continue;
        }
        store.appendOutput(execId, output);
        if (active?.execId === execId && active.attachedSocket && !active.attachedSocket.destroyed) {
          active.attachedSocket.write(encode({ type: 'output', output }));
        }
      }
      store.complete(execId);
      const active = execState.activeExecution;
      if (active?.execId === execId && active.attachedSocket && !active.attachedSocket.destroyed) {
        active.attachedSocket.write(encode({ type: 'exec_done' }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.fail(execId, message);
      const active = execState.activeExecution;
      if (active?.execId === execId && active.attachedSocket && !active.attachedSocket.destroyed) {
        active.attachedSocket.write(encode({ type: 'exec_error', message }));
      }
    } finally {
      if (execState.activeExecution?.execId === execId) {
        execState.activeExecution = undefined;
      }
    }
  }

  // Start Unix socket server early so CLI detects daemon quickly
  const socketServer = net.createServer((socket) =>
    handleClient(socket, kernel, kernelReady, execState, store, runExecution),
  );

  socketServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.log('Socket already in use by another daemon, exiting');
      process.exit(0);
    }
  });

  socketServer.listen(SOCKET_PATH, () => {
    fs.chmodSync(SOCKET_PATH, 0o600);
    console.log('Daemon ready on', SOCKET_PATH);
  });

  // Shutdown handler
  const shutdown = () => {
    console.log('Shutting down daemon');
    kernel.close();
    keepAlive.stop();
    refresher.stop();
    socketServer.close();
    cleanupFiles();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Wait for kernel connection to complete (or fail and exit)
  await kernelReady;

  // Health monitor: exit if WS disconnects unexpectedly (but not during restart)
  setInterval(() => {
    if (!kernel.isConnected && !kernel.isRestarting) {
      console.error('Kernel WebSocket disconnected, shutting down');
      shutdown();
    }
  }, 30_000).unref();
}

function handleClient(
  socket: net.Socket,
  kernel: KernelConnection,
  kernelReady: Promise<void>,
  execState: {
    activeExecution?: ActiveExecution;
  },
  store: ExecutionStore,
  runExecution: (execId: number, code: string) => Promise<void>,
) {
  const send = (msg: ServerMessage) => {
    if (!socket.destroyed) socket.write(encode(msg));
  };

  send({ type: 'ready' });

  const rl = readline.createInterface({ input: socket });
  rl.on('error', () => {});
  rl.on('line', async (line) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'exec': {
        if (execState.activeExecution) {
          send({
            type: 'exec_error',
            message: 'Daemon is already executing code for another session',
          });
          return;
        }

        const execId = store.create(msg.code);

        if (msg.background) {
          // Background mode: return exec ID immediately, run without awaiting
          execState.activeExecution = {
            execId,
            pendingAuthRequests: new Map(),
          };
          send({ type: 'exec_started', execId });
          // Fire-and-forget — execution continues after client disconnects
          runExecution(execId, msg.code).catch((err) => {
            console.error('Background execution error:', err);
          });
        } else {
          // Foreground mode: attach this socket and await completion
          execState.activeExecution = {
            execId,
            attachedSocket: socket,
            pendingAuthRequests: new Map(),
          };
          await runExecution(execId, msg.code);
        }
        break;
      }

      case 'exec_attach': {
        const exec = store.get(msg.execId);
        if (!exec) {
          send({ type: 'exec_error', message: `Execution ${msg.execId} not found` });
          return;
        }

        if (msg.noWait) {
          // Snapshot mode: send batch of outputs and return
          const outputs = store.getOutputs(msg.execId, msg.tail);
          send({
            type: 'exec_attach_batch',
            execId: msg.execId,
            outputs,
            status: exec.status,
            ...(exec.pendingInput ? { pendingInput: exec.pendingInput } : {}),
          });
        } else {
          // Streaming mode: replay buffered outputs then attach for live
          for (const output of exec.outputs) {
            send({ type: 'output', output });
          }

          if (exec.status === 'done') {
            send({ type: 'exec_done' });
            return;
          }
          if (exec.status === 'error') {
            send({ type: 'exec_error', message: exec.errorMessage ?? 'Unknown error' });
            return;
          }

          // Still running — attach this socket for live output
          const active = execState.activeExecution;
          if (active && active.execId === msg.execId) {
            active.attachedSocket = socket;
            // If there's a pending stdin request, forward it immediately
            if (exec.pendingInput) {
              send({
                type: 'input_request',
                prompt: exec.pendingInput.prompt,
                password: exec.pendingInput.password,
              });
            }
          }
        }
        break;
      }

      case 'exec_list': {
        send({ type: 'exec_list_result', executions: store.list() });
        break;
      }

      case 'exec_send': {
        const active = execState.activeExecution;
        if (!active || active.execId !== msg.execId) {
          send({ type: 'exec_error', message: `Execution ${msg.execId} is not currently running` });
          return;
        }
        if (msg.interrupt) {
          kernel.interrupt().catch(() => {});
          if (active.pendingStdinResolve) {
            active.pendingStdinResolve(undefined);
            active.pendingStdinResolve = undefined;
          }
        } else if (msg.stdin !== undefined) {
          if (active.pendingStdinResolve) {
            active.pendingStdinResolve(msg.stdin);
            active.pendingStdinResolve = undefined;
          }
        }
        break;
      }

      case 'auth_response': {
        const active = execState.activeExecution;
        const resolve = active?.pendingAuthRequests.get(msg.requestId);
        if (!resolve) return;
        active!.pendingAuthRequests.delete(msg.requestId);
        resolve(msg.error);
        break;
      }
      case 'stdin_reply': {
        const active = execState.activeExecution;
        if (active?.pendingStdinResolve) {
          active.pendingStdinResolve(msg.value);
          active.pendingStdinResolve = undefined;
        }
        break;
      }
      case 'interrupt':
        kernel.interrupt().catch(() => {});
        if (execState.activeExecution?.pendingStdinResolve) {
          execState.activeExecution.pendingStdinResolve(undefined);
          execState.activeExecution.pendingStdinResolve = undefined;
        }
        break;
      case 'restart':
        try {
          await kernel.restartKernel();
          send({ type: 'restarted' });
        } catch (err) {
          send({
            type: 'restart_error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case 'ping':
        send({ type: 'pong' });
        break;
    }
  });

  socket.on('error', () => {});
  socket.on('close', () => {
    const active = execState.activeExecution;
    if (active && active.attachedSocket === socket) {
      // Detach socket but do NOT stop execution
      for (const resolve of active.pendingAuthRequests.values()) {
        resolve('CLI session closed before authorization completed');
      }
      active.pendingAuthRequests.clear();
      if (active.pendingStdinResolve) {
        active.pendingStdinResolve(undefined);
        active.pendingStdinResolve = undefined;
      }
      active.attachedSocket = undefined;
    }
    rl.close();
  });
}

main().catch((err) => {
  console.error('Daemon failed:', err);
  cleanupFiles();
  process.exit(1);
});
