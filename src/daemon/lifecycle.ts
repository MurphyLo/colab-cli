import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { UUID } from 'crypto';
import { CONFIG_DIR } from '../config.js';
import { log } from '../logging/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = path.join(__dirname, 'server.js');

export function getSocketPath(serverId: UUID): string {
  return path.join(CONFIG_DIR, `daemon-${serverId}.sock`);
}

function getPidPath(serverId: UUID): string {
  return path.join(CONFIG_DIR, `daemon-${serverId}.pid`);
}

function getLogPath(serverId: UUID): string {
  return path.join(CONFIG_DIR, `daemon-${serverId}.log`);
}

export function isDaemonRunning(serverId: UUID): boolean {
  const pidPath = getPidPath(serverId);
  try {
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    cleanupStaleFiles(serverId);
    return false;
  }
}

function cleanupStaleFiles(serverId: UUID): void {
  try { fs.unlinkSync(getPidPath(serverId)); } catch {}
  try { fs.unlinkSync(getSocketPath(serverId)); } catch {}
}

export async function startDaemon(serverId: UUID): Promise<void> {
  if (isDaemonRunning(serverId)) {
    log.debug('Daemon already running for', serverId);
    return;
  }

  log.debug('Starting daemon for', serverId);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  const logPath = getLogPath(serverId);
  const logFd = fs.openSync(logPath, 'a');

  const child = spawn(
    process.execPath,
    ['--use-env-proxy', DAEMON_SCRIPT, serverId],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    },
  );
  child.unref();
  fs.closeSync(logFd);

  const socketPath = getSocketPath(serverId);
  await waitForSocket(serverId, socketPath, 30_000);
  log.debug('Daemon started for', serverId);
}

async function waitForSocket(
  serverId: UUID,
  socketPath: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await canConnect(socketPath)) return;
    await sleep(200);
  }
  throw new Error(
    'Daemon failed to start within timeout. Check logs at: ' +
      getLogPath(serverId),
  );
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.connect(socketPath, () => {
      client.destroy();
      resolve(true);
    });
    client.on('error', () => resolve(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function stopDaemon(serverId: UUID): void {
  const pidPath = getPidPath(serverId);
  try {
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    process.kill(pid, 'SIGTERM');
    log.debug('Sent SIGTERM to daemon', pid, 'for', serverId);
  } catch {
    // Process already dead
  }
  cleanupStaleFiles(serverId);
}
