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

function getLockPath(serverId: UUID): string {
  return path.join(CONFIG_DIR, `daemon-${serverId}.lock`);
}

/**
 * A daemon is "running" iff its Unix socket accepts connections. The .pid file
 * is informational only — signal probing via `process.kill(pid, 0)` was
 * unreliable under macOS sandboxing and across PID reuse, and misclassifying a
 * live daemon as dead caused silent state loss (duplicate daemons, orphaned
 * port forwards, empty `port-forward list`). Socket reachability is what
 * clients actually care about, so use it as the single source of truth.
 */
export async function isDaemonRunning(serverId: UUID): Promise<boolean> {
  return canConnect(getSocketPath(serverId));
}

/** In-process dedup: coalesce concurrent startDaemon calls for the same server. */
const pendingStarts = new Map<string, Promise<void>>();

export async function startDaemon(serverId: UUID): Promise<void> {
  const pending = pendingStarts.get(serverId);
  if (pending) {
    await pending;
    return;
  }

  const promise = startDaemonWithLock(serverId);
  pendingStarts.set(serverId, promise);
  try {
    await promise;
  } finally {
    pendingStarts.delete(serverId);
  }
}

/**
 * Acquire a cross-process lock (atomic mkdir), then spawn the daemon if needed.
 * If another process holds the lock, wait until the daemon is reachable or the
 * lock is released.
 */
async function startDaemonWithLock(serverId: UUID): Promise<void> {
  if (await isDaemonRunning(serverId)) {
    log.debug('Daemon already running for', serverId);
    return;
  }

  const lockPath = getLockPath(serverId);
  const maxWait = 30_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    if (tryAcquireLock(lockPath)) {
      try {
        // Re-check under lock — another process may have started the daemon
        if (await isDaemonRunning(serverId)) {
          log.debug('Daemon already running for', serverId);
          return;
        }
        return await spawnAndWait(serverId);
      } finally {
        releaseLock(lockPath);
      }
    }

    // Lock held by another process — it's starting the daemon.
    // Wait for the daemon to become reachable or the lock to be released.
    if (await canConnect(getSocketPath(serverId))) return;
    await sleep(200);
  }

  throw new Error(
    'Timed out waiting to start daemon. Check logs at: ' +
      getLogPath(serverId),
  );
}

/**
 * Daemon startup is bounded by `spawnAndWait`'s 30s timeout; a lock older than
 * this cannot belong to a live starter. Using mtime instead of PID probing
 * avoids the same EPERM/reuse hazards that killed signal-based liveness.
 */
const LOCK_STALE_MS = 60_000;

function tryAcquireLock(lockPath: string): boolean {
  try {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'pid'), String(process.pid));
    return true;
  } catch (err: any) {
    if (err.code !== 'EEXIST') return false;

    let ageMs: number;
    try {
      ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    } catch {
      return false; // can't stat — assume held
    }
    if (ageMs < LOCK_STALE_MS) return false; // fresh lock, holder active

    // Stale lock — try to steal it. If another process clears it first, we
    // lose and retry on the next iteration of the caller's wait loop.
    try {
      fs.rmSync(lockPath, { recursive: true });
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, 'pid'), String(process.pid));
      return true;
    } catch {
      return false;
    }
  }
}

function releaseLock(lockPath: string): void {
  try { fs.rmSync(lockPath, { recursive: true }); } catch {}
}

async function spawnAndWait(serverId: UUID): Promise<void> {
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

/**
 * Ask the daemon to shut down. Preferred path is the in-protocol `shutdown`
 * message, which lets the daemon clean up shells, port forwards, the kernel,
 * and its own `.sock` / `.pid` files. SIGTERM is a fallback for the case
 * where the socket is unreachable (daemon stuck or already half-dead). File
 * cleanup is intentionally left to the daemon — signaling a stale PID that
 * was reused by an unrelated process must not trash active daemon state.
 */
export async function stopDaemon(serverId: UUID): Promise<void> {
  const socketPath = getSocketPath(serverId);

  const sent = await sendShutdown(socketPath);
  if (sent) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (!(await canConnect(socketPath))) return;
      await sleep(100);
    }
    // Daemon acknowledged but didn't exit in time — fall through to SIGTERM.
  }

  try {
    const pid = parseInt(fs.readFileSync(getPidPath(serverId), 'utf-8').trim(), 10);
    if (Number.isFinite(pid)) {
      process.kill(pid, 'SIGTERM');
      log.debug('Sent SIGTERM to daemon', pid, 'for', serverId);
    }
  } catch {
    // .pid missing / unreadable, or signal denied — nothing more we can do
    // safely. Daemon owns cleanup; next startup will reclaim the socket.
  }
}

function sendShutdown(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.connect(socketPath, () => {
      client.write('{"type":"shutdown"}\n');
      client.end();
      resolve(true);
    });
    client.on('error', () => resolve(false));
  });
}
