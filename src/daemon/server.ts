#!/usr/bin/env node

import net from 'net';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { UUID } from 'crypto';
import { AuthManager } from '../auth/auth-manager.js';
import { ColabClient } from '../colab/client.js';
import { KernelConnection } from '../jupyter/kernel-connection.js';
import { KeepAlive } from '../runtime/keep-alive.js';
import { ConnectionRefresher } from '../runtime/connection-refresher.js';
import { getStoredServer } from '../runtime/storage.js';
import { COLAB_API_DOMAIN, COLAB_GAPI_DOMAIN, CONFIG_DIR } from '../config.js';
import type { ClientMessage, ServerMessage } from './protocol.js';
import { encode } from './protocol.js';

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

async function main() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
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

  // Create kernel (connect later, after socket is listening)
  const kernel = new KernelConnection(
    () => refresher.proxyUrl,
    () => refresher.token,
    colabClient,
    server.endpoint,
  );

  // Begin kernel connection (may be slow on cold-start GPU runtimes).
  // Store the promise so exec handlers can await it instead of failing early.
  console.log('Connecting to kernel...');
  const kernelReady = kernel.connect().then(() => {
    console.log('Kernel connected');
  });

  // Start Unix socket server early so CLI detects daemon quickly
  const socketServer = net.createServer((socket) =>
    handleClient(socket, kernel, kernelReady),
  );

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
        try {
          // Wait for kernel to be ready if still connecting at startup
          await kernelReady;
          if (!kernel.isConnected) {
            send({
              type: 'exec_error',
              message: 'Kernel not connected',
            });
            return;
          }
          const outputs = await kernel.execute(msg.code);
          for await (const output of outputs) {
            send({ type: 'output', output });
          }
          send({ type: 'exec_done' });
        } catch (err) {
          send({
            type: 'exec_error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
      case 'interrupt':
        kernel.interrupt().catch(() => {});
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
  socket.on('close', () => rl.close());
}

main().catch((err) => {
  console.error('Daemon failed:', err);
  cleanupFiles();
  process.exit(1);
});
