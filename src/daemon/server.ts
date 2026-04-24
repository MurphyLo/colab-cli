#!/usr/bin/env node

import net from 'net';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { randomUUID, UUID } from 'crypto';
import { AuthManager } from '../auth/auth-manager.js';
import { AuthType } from '../colab/api.js';
import { ColabClient, ColabRequestError } from '../colab/client.js';
import { KernelConnection } from '../jupyter/kernel-connection.js';
import { KeepAlive } from '../runtime/keep-alive.js';
import { ConnectionRefresher } from '../runtime/connection-refresher.js';
import { getStoredServer } from '../runtime/storage.js';
import { COLAB_API_DOMAIN, COLAB_GAPI_DOMAIN, CONFIG_DIR } from '../config.js';
import type { ClientMessage, ServerMessage, ShellStatus } from './protocol.js';
import { encode } from './protocol.js';
import { ExecutionStore } from './execution-store.js';
import { TerminalConnection } from '../terminal/terminal-connection.js';
import { TerminalBuffer } from '../terminal/terminal-buffer.js';
import { ForwardSession } from '../port-forward/session.js';
import { getTlsCredentials } from '../port-forward/tls.js';

const serverId = process.argv[2] as UUID;
if (!serverId) {
  console.error('Usage: server.js <server-id>');
  process.exit(1);
}

const SOCKET_PATH = path.join(CONFIG_DIR, `daemon-${serverId}.sock`);
const PID_FILE = path.join(CONFIG_DIR, `daemon-${serverId}.pid`);

function cleanupFiles() {
  // Only remove files we actually own. If another daemon has taken over the
  // socket (e.g. we lost a startup race and are exiting), leave its files
  // intact instead of deleting them out from under it.
  let ownedByUs = false;
  try {
    const storedPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    ownedByUs = storedPid === process.pid;
  } catch {
    return;
  }
  if (!ownedByUs) return;
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

/**
 * Claim the daemon's Unix socket. If another daemon is already listening, exit
 * cleanly. If the socket file is stale (nothing is listening), remove it and
 * retry. This atomic helper replaces the legacy isSocketAlive → unlink →
 * listen dance, which had a race window where two concurrent daemons could
 * both conclude the socket was stale and both try to listen.
 */
async function claimSocket(server: net.Server, socketPath: string): Promise<void> {
  const doListen = () => new Promise<void>((resolve, reject) => {
    const onError = (err: unknown) => reject(err);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  try {
    await doListen();
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
  }

  if (await isSocketAlive(socketPath)) {
    console.log('Another daemon is already serving, exiting');
    process.exit(0);
  }

  try { fs.unlinkSync(socketPath); } catch {}
  await doListen();
}

interface ActiveExecution {
  execId: number;
  attachedSocket?: net.Socket;
  pendingAuthRequests: Map<string, (error?: string) => void>;
  pendingStdinResolve?: (value: string | undefined) => void;
  /** Resolves when background auth polling is interrupted. */
  pendingAuthInterruptResolve?: () => void;
}

interface ActiveShell {
  shellId: number;
  tmuxSession: string;
  connection: TerminalConnection;
  buffer: TerminalBuffer;
  attachedSocket?: net.Socket;
  startedAt: Date;
  status: ShellStatus;
  /** Remote tmux terminal dimensions — last value we sent via sendResize,
   * used by snapshot rendering to emulate the screen accurately. */
  cols: number;
  rows: number;
}

const DEFAULT_SHELL_COLS = 80;
const DEFAULT_SHELL_ROWS = 24;

const MAX_CONCURRENT_SHELLS = 10;
const MAX_CONCURRENT_PORT_FORWARDS = 20;

/**
 * Colab's `/colab/tty` endpoint auto-attaches every new WebSocket to a fixed
 * server-side tmux session (default `0`) with `attach -d`, which kicks off any
 * prior client. To let multiple shells coexist, each shell is relocated into
 * its own tmux session right after the WebSocket opens — see the `shell_open`
 * handler below.
 */
const TMUX_SESSION_PREFIX = 'cli-';
const SHELL_BOOTSTRAP_SETTLE_MS = 400;

const AUTH_POLL_INTERVAL_MS = 5_000;
const AUTH_POLL_TIMEOUT_MS = 120_000;

async function main() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  // Fast exit if a peer daemon is already live — skip the rest of startup.
  // The authoritative claim happens below via claimSocket once the server
  // instance is built.
  if (await isSocketAlive(SOCKET_PATH)) {
    console.log('Another daemon is already serving, exiting');
    process.exit(0);
  }

  // Initialize auth
  const authManager = new AuthManager();
  await authManager.initialize();
  if (!authManager.isLoggedIn()) {
    console.error('Not logged in');
    process.exit(1);
  }

  // Load server info
  const server = getStoredServer(serverId);
  if (!server) {
    console.error('Server not found:', serverId);
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
  const shellState: {
    shells: Map<number, ActiveShell>;
    nextShellId: number;
  } = { shells: new Map(), nextShellId: 1 };
  const forwardState: {
    sessions: Map<number, ForwardSession>;
    nextId: number;
  } = { sessions: new Map(), nextId: 1 };

  const propagateCredentialsOrThrow = async (authType: AuthType): Promise<void> => {
    const result = await colabClient.propagateCredentials(server.endpoint, {
      authType,
      dryRun: false,
    });
    if (!result.success) {
      throw new Error(`[${authType}] Credentials propagation unsuccessful`);
    }
  };

  const tryPropagateCredentialsForPolling = async (authType: AuthType): Promise<boolean> => {
    try {
      const result = await colabClient.propagateCredentials(server.endpoint, {
        authType,
        dryRun: false,
      });
      return result.success;
    } catch (err) {
      // During polling, treat 4xx responses as "authorization not ready yet"
      // and keep waiting; surface transport and server failures immediately.
      if (err instanceof ColabRequestError && err.status >= 400 && err.status < 500) {
        return false;
      }
      throw err;
    }
  };

  const requestEphemeralAuth = async (authType: AuthType): Promise<void> => {
    const active = execState.activeExecution;
    if (!active) {
      throw new Error('No active execution for auth');
    }

    // Pre-compute auth state so we can (a) auto-propagate when credentials
    // are already available and (b) surface the auth URL to non-interactive
    // callers such as `exec attach --no-wait` and `exec list`.
    let authUrl: string | undefined;
    try {
      const dryRun = await colabClient.propagateCredentials(server.endpoint, {
        authType,
        dryRun: true,
      });
      if (dryRun.success) {
        // Credentials already available — propagate directly, no user action.
        await propagateCredentialsOrThrow(authType);
        return;
      }
      if (!dryRun.unauthorizedRedirectUri) {
        throw new Error(
          `[${authType}] Credentials propagation dry run returned unexpected results: ${JSON.stringify(dryRun)}`,
        );
      }
      authUrl = dryRun.unauthorizedRedirectUri;
    } catch (err) {
      console.error('dryRun pre-check failed:', err);
    }

    // No attached socket (background exec) — store the URL and poll every 5s
    // with dryRun=false until propagation succeeds.
    if (!active.attachedSocket || active.attachedSocket.destroyed) {
      if (!authUrl) {
        throw new Error(`[${authType}] No authorization URL available for background auth`);
      }
      store.setPendingAuth(active.execId, authType, authUrl);
      const interrupted = new Promise<'interrupted'>((resolve) => {
        active.pendingAuthInterruptResolve = () => resolve('interrupted');
      });
      try {
        const deadline = Date.now() + AUTH_POLL_TIMEOUT_MS;
        while (true) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            throw new Error('Authorization timed out');
          }

          const tick = new Promise<'tick'>((resolve) => {
            setTimeout(() => resolve('tick'), Math.min(AUTH_POLL_INTERVAL_MS, remaining));
          });
          const wakeReason = await Promise.race([tick, interrupted]);
          if (wakeReason === 'interrupted') {
            throw new Error('Authorization interrupted');
          }

          if (await tryPropagateCredentialsForPolling(authType)) {
            return;
          }
        }
      } finally {
        active.pendingAuthInterruptResolve = undefined;
        store.clearPendingAuth(active.execId);
      }
    }

    // Socket is now available — proceed with normal auth flow
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
    server.kernelName ?? 'python3',
    requestEphemeralAuth,
  );

  // Begin kernel connection (may be slow on cold-start GPU runtimes). The
  // promise is stored so exec handlers can await it instead of failing early.
  // Kernel failure does NOT take down the daemon — shell, port-forward, and
  // future kernel restarts must remain available even when the initial
  // Jupyter WebSocket times out. The .catch below observes the rejection so
  // Node doesn't log unhandledRejection; later `await kernelReady` calls in
  // exec handlers still see the rejected state and fail the exec cleanly.
  console.log('Connecting to kernel...');
  const kernelReady = kernel.connect().then(() => {
    console.log('Kernel connected');
  });
  kernelReady.catch((err) => {
    console.error('Kernel connection failed:', err instanceof Error ? err.message : err);
  });

  /** Run execution and route outputs to store + attached socket. */
  async function runExecution(execId: number, code: string): Promise<void> {
    try {
      await kernelReady;
      if (!kernel.isConnected) {
        const message = kernel.isReconnecting
          ? 'Kernel WebSocket is reconnecting, retry in a few seconds.'
          : 'Kernel WebSocket disconnected and auto-reconnect failed. Run `colab runtime restart` to restore exec (resets kernel state; shell and port-forward unaffected).';
        store.fail(execId, message);
        const active = execState.activeExecution;
        if (active?.execId === execId && active.attachedSocket && !active.attachedSocket.destroyed) {
          active.attachedSocket.write(encode({ type: 'exec_error', message }));
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
          }
          // Wait for stdin via exec_send, attached client, or interrupt
          const value = await new Promise<string | undefined>((resolve) => {
            if (active?.execId === execId) {
              active.pendingStdinResolve = resolve;
            } else {
              resolve(undefined);
            }
          });
          if (active?.execId === execId) {
            active.pendingStdinResolve = undefined;
          }
          store.clearPendingInput(execId);
          if (value !== undefined) {
            kernel.sendStdinReply(value);
          }
          // undefined means interrupted — skip reply, continue consuming outputs
          continue;
        }
        const stored = store.appendOutput(execId, output);
        if (active?.execId === execId && active.attachedSocket && !active.attachedSocket.destroyed) {
          active.attachedSocket.write(encode({ type: 'output', output: stored }));
        }
      }
      store.complete(execId);
      const active = execState.activeExecution;
      if (active?.execId === execId && active.attachedSocket && !active.attachedSocket.destroyed) {
        active.attachedSocket.write(encode({ type: 'exec_done' }));
      }
    } catch (err) {
      let message = err instanceof Error ? err.message : String(err);
      if (!kernel.isConnected && !kernel.isReconnecting) {
        message += '. Run `colab runtime restart` to restore exec (resets kernel state; shell and port-forward unaffected).';
      }
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
    handleClient(
      socket,
      kernel,
      kernelReady,
      execState,
      store,
      runExecution,
      shellState,
      refresher,
      forwardState,
      colabClient,
      server.endpoint,
    ),
  );

  // Atomically claim the socket. If a peer daemon won the race, exit cleanly
  // (without touching its files). Only after the listener is bound do we
  // publish the PID file — that way `isDaemonRunning` never observes a PID
  // belonging to a process that has not yet (or never will) bind the socket.
  await claimSocket(socketServer, SOCKET_PATH);
  fs.chmodSync(SOCKET_PATH, 0o600);
  fs.writeFileSync(PID_FILE, String(process.pid));
  console.log('Daemon ready on', SOCKET_PATH);

  // Shutdown handler
  const shutdown = () => {
    console.log('Shutting down daemon');
    for (const shell of shellState.shells.values()) {
      shell.connection.close();
    }
    shellState.shells.clear();
    for (const session of forwardState.sessions.values()) {
      session.close().catch(() => {});
    }
    forwardState.sessions.clear();
    kernel.close();
    keepAlive.stop();
    refresher.stop();
    socketServer.close();
    cleanupFiles();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // The daemon stays alive as long as the socket server runs. Kernel failure
  // is handled per-exec via `await kernelReady` in runExecution; shell and
  // port-forward sessions are independent of kernel state.
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
  shellState: {
    shells: Map<number, ActiveShell>;
    nextShellId: number;
  },
  refresher: ConnectionRefresher,
  forwardState: {
    sessions: Map<number, ForwardSession>;
    nextId: number;
  },
  colabClient: ColabClient,
  endpoint: string,
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

        const execId = store.create(msg.code, msg.outputDir);

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
            ...(exec.pendingAuth ? { pendingAuth: exec.pendingAuth } : {}),
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
            // Surface the current auth URL on streaming attach so users don't
            // have to switch to --no-wait just to retrieve it.
            if (exec.pendingAuth?.authUrl) {
              send({
                type: 'output',
                output: {
                  type: 'stream',
                  name: 'stderr',
                  text:
                    '[waiting for authorization — visit the URL below; execution will resume automatically after authorization completes]\n' +
                    `[auth url: ${exec.pendingAuth.authUrl}]\n`,
                },
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

      case 'exec_clear': {
        const count = store.clear(msg.execId);
        send({ type: 'exec_clear_result', count });
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
        if (execState.activeExecution?.pendingAuthInterruptResolve) {
          execState.activeExecution.pendingAuthInterruptResolve();
          execState.activeExecution.pendingAuthInterruptResolve = undefined;
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

      case 'shutdown':
        socket.end();
        process.kill(process.pid, 'SIGTERM');
        break;

      // ── Shell session handlers ──

      case 'shell_open': {
        if (shellState.shells.size >= MAX_CONCURRENT_SHELLS) {
          send({ type: 'shell_error', message: `Maximum concurrent shell sessions (${MAX_CONCURRENT_SHELLS}) reached` });
          return;
        }

        const shellId = shellState.nextShellId++;
        const tmuxSession = `${TMUX_SESSION_PREFIX}${shellId}`;
        const buffer = new TerminalBuffer();

        const connection = new TerminalConnection(
          () => refresher.proxyUrl,
          () => refresher.token,
          {
            onData: (data) => {
              const shell = shellState.shells.get(shellId);
              if (!shell) return;
              shell.buffer.append(data);
              if (shell.attachedSocket && !shell.attachedSocket.destroyed) {
                shell.attachedSocket.write(encode({ type: 'shell_output', shellId, data }));
              }
            },
            onOpen: () => {
              console.log(`Shell ${shellId} connected (tmux session ${tmuxSession})`);
            },
            onClose: (code, reason) => {
              // onClose only fires after all reconnect attempts are exhausted
              const shell = shellState.shells.get(shellId);
              if (!shell) return;
              shell.status = 'closed';
              if (shell.attachedSocket && !shell.attachedSocket.destroyed) {
                shell.attachedSocket.write(encode({ type: 'shell_closed', shellId, reason: reason || 'connection closed' }));
              }
              console.log(`Shell ${shellId} closed: code=${code} reason=${reason || '(none)'}`);
              setTimeout(() => shellState.shells.delete(shellId), 5 * 60 * 1000);
            },
            onError: (err) => {
              // Errors during reconnect are handled internally; this fires
              // for non-recoverable errors only (e.g. initial connect failure).
              const shell = shellState.shells.get(shellId);
              if (!shell) return;
              if (shell.connection.isReconnecting) return; // suppress during reconnect
              shell.status = 'closed';
              if (shell.attachedSocket && !shell.attachedSocket.destroyed) {
                shell.attachedSocket.write(encode({ type: 'shell_closed', shellId, reason: err.message }));
              }
              console.error(`Shell ${shellId} error:`, err.message);
              setTimeout(() => shellState.shells.delete(shellId), 5 * 60 * 1000);
            },
            onReconnecting: (attempt, maxAttempts) => {
              console.log(`Shell ${shellId} reconnecting (attempt ${attempt}/${maxAttempts})...`);
            },
            onReconnected: () => {
              const shell = shellState.shells.get(shellId);
              if (!shell) return;
              console.log(`Shell ${shellId} reconnected, re-attaching tmux session ${tmuxSession}`);
              // Re-switch to the shell's own tmux session. The tmux session
              // survived the WS disconnect, so all state is preserved.
              shell.connection.send(`tmux switch-client -t ${tmuxSession}\n`);
            },
          },
        );

        const shell: ActiveShell = {
          shellId,
          tmuxSession,
          connection,
          buffer,
          startedAt: new Date(),
          status: 'running',
          cols: msg.cols || DEFAULT_SHELL_COLS,
          rows: msg.rows || DEFAULT_SHELL_ROWS,
        };
        shellState.shells.set(shellId, shell);

        try {
          await connection.connect();

          // Relocate this shell into its own tmux session so concurrent shells
          // on the same runtime don't kick each other off the shared `/colab/tty`
          // session. `kill-session` guards against a stale session left behind
          // by a previous daemon instance (nextShellId resets on daemon restart).
          connection.send(
            `tmux kill-session -t ${tmuxSession} 2>/dev/null; ` +
            `tmux new-session -d -s ${tmuxSession}; ` +
            `tmux set-option -t ${tmuxSession} status off; ` +
            `tmux switch-client -t ${tmuxSession}\n`,
          );
          // Wait for the bootstrap to settle, then drop redraw noise from the
          // replay buffer. No client is attached yet (shell_opened is sent
          // below), so this doesn't affect any viewer.
          await new Promise((r) => setTimeout(r, SHELL_BOOTSTRAP_SETTLE_MS));
          buffer.clear();

          // Send initial resize if dimensions provided
          if (msg.cols && msg.rows) {
            connection.sendResize(msg.cols, msg.rows);
          }
          send({ type: 'shell_opened', shellId });
        } catch (err) {
          shellState.shells.delete(shellId);
          connection.close();
          send({
            type: 'shell_error',
            message: `Failed to open shell: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        break;
      }

      case 'shell_input': {
        const shell = shellState.shells.get(msg.shellId);
        if (!shell || shell.status === 'closed') {
          send({ type: 'shell_error', message: `Shell ${msg.shellId} not found or closed` });
          return;
        }
        shell.connection.send(msg.data);
        break;
      }

      case 'shell_resize': {
        const shell = shellState.shells.get(msg.shellId);
        if (!shell || shell.status === 'closed') return;
        shell.connection.sendResize(msg.cols, msg.rows);
        shell.cols = msg.cols;
        shell.rows = msg.rows;
        break;
      }

      case 'shell_detach': {
        const shell = shellState.shells.get(msg.shellId);
        if (shell && shell.attachedSocket === socket) {
          shell.attachedSocket = undefined;
        }
        break;
      }

      case 'shell_attach': {
        const shell = shellState.shells.get(msg.shellId);
        if (!shell) {
          send({ type: 'shell_error', message: `Shell ${msg.shellId} not found` });
          return;
        }

        if (msg.noWait) {
          // Snapshot mode: render the buffered output through a virtual screen
          // so cursor-positioning redraws (tmux forwarding, rich.progress
          // panels) collapse to the final visible text. `tail` counts lines.
          const buffered = shell.buffer.getSnapshot(shell.cols, shell.rows, msg.tail);
          send({ type: 'shell_attach_batch', shellId: msg.shellId, buffered, status: shell.status });
        } else {
          // Streaming mode: attach socket for live output
          // Detach previous client if any
          if (shell.attachedSocket && shell.attachedSocket !== socket && !shell.attachedSocket.destroyed) {
            shell.attachedSocket.write(encode({ type: 'shell_closed', shellId: msg.shellId, reason: 'detached by another client' }));
          }
          shell.attachedSocket = socket;
          const buffered = shell.buffer.getContents();
          send({ type: 'shell_attached', shellId: msg.shellId, buffered });
          // Send resize to remote terminal if dimensions provided
          if (msg.cols && msg.rows && shell.status === 'running') {
            shell.connection.sendResize(msg.cols, msg.rows);
            shell.cols = msg.cols;
            shell.rows = msg.rows;
          }
          // If shell already closed, notify immediately
          if (shell.status === 'closed') {
            send({ type: 'shell_closed', shellId: msg.shellId, reason: 'session ended before attach' });
          }
        }
        break;
      }

      case 'shell_list': {
        const shells = Array.from(shellState.shells.values()).map((s) => ({
          shellId: s.shellId,
          status: s.status,
          startedAt: s.startedAt.toISOString(),
          attached: s.attachedSocket !== undefined && !s.attachedSocket.destroyed,
        }));
        send({ type: 'shell_list_result', shells });
        break;
      }

      case 'shell_send': {
        const shell = shellState.shells.get(msg.shellId);
        if (!shell || shell.status === 'closed') {
          send({ type: 'shell_error', message: `Shell ${msg.shellId} not found or closed` });
          return;
        }
        shell.connection.send(msg.data);
        send({ type: 'shell_send_ack', shellId: msg.shellId });
        break;
      }

      // ── Port-forward handlers ──

      case 'port_forward_create': {
        if (forwardState.sessions.size >= MAX_CONCURRENT_PORT_FORWARDS) {
          send({
            type: 'port_forward_error',
            message: `Maximum concurrent port forwards (${MAX_CONCURRENT_PORT_FORWARDS}) reached`,
          });
          return;
        }
        const id = forwardState.nextId++;
        try {
          const tlsCreds = msg.tls ? await getTlsCredentials() : undefined;
          const session = await ForwardSession.open(
            id,
            msg.localHost,
            msg.localPort,
            msg.remotePort,
            colabClient,
            endpoint,
            tlsCreds,
          );
          forwardState.sessions.set(id, session);
          send({
            type: 'port_forward_created',
            id,
            localHost: session.localHost,
            localPort: session.localPort,
            remotePort: session.remotePort,
            proxyUrl: session.proxyUrl,
            tls: session.tls,
          });
          console.log(
            `Port forward ${id}: ${session.localHost}:${session.localPort} → remote ${session.remotePort}`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          send({ type: 'port_forward_error', message });
        }
        break;
      }

      case 'port_forward_list': {
        const sessions = Array.from(forwardState.sessions.values()).map((s) => ({
          id: s.id,
          localHost: s.localHost,
          localPort: s.localPort,
          remotePort: s.remotePort,
          startedAt: s.startedAt.toISOString(),
          proxyUrl: s.proxyUrl,
          tls: s.tls,
        }));
        send({ type: 'port_forward_list_result', sessions });
        break;
      }

      case 'port_forward_close': {
        const targets: ForwardSession[] = [];
        if (msg.all) {
          targets.push(...forwardState.sessions.values());
        } else if (msg.id !== undefined) {
          const session = forwardState.sessions.get(msg.id);
          if (!session) {
            send({ type: 'port_forward_error', message: `Port forward ${msg.id} not found` });
            return;
          }
          targets.push(session);
        } else {
          send({ type: 'port_forward_error', message: 'Must specify id or all' });
          return;
        }
        const ids: number[] = [];
        for (const session of targets) {
          try {
            await session.close();
          } catch (err) {
            console.error(`Port forward ${session.id} close error:`, err);
          }
          forwardState.sessions.delete(session.id);
          ids.push(session.id);
        }
        send({ type: 'port_forward_closed', ids });
        break;
      }
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
      // Detach the socket but keep the execution running in the daemon.
      active.attachedSocket = undefined;
    }
    // Detach this socket from any shell sessions (shells keep running)
    for (const shell of shellState.shells.values()) {
      if (shell.attachedSocket === socket) {
        shell.attachedSocket = undefined;
      }
    }
    rl.close();
  });
}

main().catch((err) => {
  console.error('Daemon failed:', err);
  cleanupFiles();
  process.exit(1);
});
