import fs from 'fs';
import path from 'path';
import { DaemonClient } from '../daemon/client.js';
import { isDaemonRunning } from '../daemon/lifecycle.js';
import { RuntimeManager } from '../runtime/runtime-manager.js';
import { listStoredServers } from '../runtime/storage.js';
import { createSpinner } from '../output/json-output.js';
import { CONFIG_DIR, SHELL_COUNTER_FILE } from '../config.js';

/** Signal name → raw byte mapping. */
const SIGNAL_MAP: Record<string, string> = {
  INT: '\x03',
  ETX: '\x03',
  EOF: '\x04',
  TSTP: '\x1a',
  SUSP: '\x1a',
  QUIT: '\x1c',
};

/**
 * Resolve `--data` escape sequences (e.g. `\n`, `\x03`) to actual characters.
 */
function unescapeData(raw: string): string {
  return raw.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  ).replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

const SHELL_LOCK_PATH = path.join(CONFIG_DIR, 'shell-id.lock');

async function allocateShellId(): Promise<number> {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const maxWait = 5_000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      fs.mkdirSync(SHELL_LOCK_PATH);
      try {
        let nextId = 1;
        try {
          nextId = parseInt(fs.readFileSync(SHELL_COUNTER_FILE, 'utf-8').trim(), 10) || 1;
        } catch {}
        fs.writeFileSync(SHELL_COUNTER_FILE, String(nextId + 1), { mode: 0o600 });
        return nextId;
      } finally {
        try { fs.rmSync(SHELL_LOCK_PATH, { recursive: true }); } catch {}
      }
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(SHELL_LOCK_PATH).mtimeMs > 10_000) {
          try { fs.rmSync(SHELL_LOCK_PATH, { recursive: true }); } catch {}
          continue;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 50));
    }
  }
  throw new Error('Failed to allocate shell ID: lock timeout');
}

async function findShellDaemon(shellId: number): Promise<DaemonClient> {
  const servers = listStoredServers();
  for (const server of servers) {
    if (!(await isDaemonRunning(server.id))) continue;
    try {
      const client = new DaemonClient();
      await client.connect(server.id);
      try {
        const shells = await client.shellList();
        if (shells.some(s => s.shellId === shellId)) {
          return client;
        }
      } catch {
        // shellList failed, skip
      }
      client.close();
    } catch {
      // connect failed, nothing to close
    }
  }
  throw new Error(`Shell ${shellId} not found`);
}

export async function shellCommand(
  runtimeManager: RuntimeManager,
  options: {
    endpoint?: string;
    background?: boolean;
  },
): Promise<void> {
  const server = await runtimeManager.resolveTarget(options.endpoint);
  const shellId = await allocateShellId();

  const spinner = createSpinner('Connecting to shell...').start();
  const client = new DaemonClient();
  try {
    await client.connect(server.id);
  } catch (err) {
    spinner.fail('Failed to connect to daemon');
    throw err;
  }

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  try {
    await client.shellOpen(cols, rows, shellId);
    spinner.stop();
  } catch (err) {
    spinner.fail('Failed to open shell');
    throw err;
  }

  if (options.background) {
    // Background mode: print shell ID and exit
    console.log(shellId);
    client.close();
    return;
  }

  // Foreground mode: attach and enter interactive session
  try {
    const buffered = await client.shellAttach(shellId, cols, rows);
    if (buffered) {
      process.stdout.write(buffered);
    }
    await runShellSession(client, shellId);
  } catch (err) {
    client.close();
    throw err;
  }
}

export async function shellAttachCommand(
  shellId: number,
  options: {
    noWait?: boolean;
    tail?: number;
  },
): Promise<void> {
  const client = await findShellDaemon(shellId);

  const noWait = options.noWait || options.tail !== undefined;

  if (noWait) {
    try {
      const result = await client.shellAttachSnapshot(shellId, options.tail);
      if (result.buffered) {
        process.stdout.write(result.buffered);
      }
      console.error(`[status: ${result.status}]`);
    } finally {
      client.close();
    }
    return;
  }

  // Streaming attach
  try {
    const buffered = await client.shellAttach(
      shellId,
      process.stdout.columns || 80,
      process.stdout.rows || 24,
    );
    if (buffered) {
      process.stdout.write(buffered);
    }
    await runShellSession(client, shellId);
  } catch (err) {
    client.close();
    throw err;
  }
}

export async function shellListCommand(): Promise<void> {
  const servers = listStoredServers();
  const allShells: Array<{
    shellId: number;
    endpoint: string;
    status: string;
    startedAt: string;
    attached: boolean;
  }> = [];

  for (const server of servers) {
    if (!(await isDaemonRunning(server.id))) continue;
    try {
      const client = new DaemonClient();
      await client.connect(server.id);
      try {
        const shells = await client.shellList();
        for (const s of shells) {
          allShells.push({ ...s, endpoint: server.endpoint });
        }
      } finally {
        client.close();
      }
    } catch {
      // Daemon unreachable, skip
    }
  }

  if (allShells.length === 0) {
    console.log('No shell sessions.');
    return;
  }

  allShells.sort((a, b) => a.shellId - b.shellId);

  const header = 'ID\tENDPOINT\tSTATUS\tSTARTED\t\t\t\tATTACHED';
  console.log(header);
  for (const s of allShells) {
    const started = new Date(s.startedAt).toLocaleString();
    console.log(`${s.shellId}\t${s.endpoint}\t${s.status}\t${started}\t${s.attached ? 'yes' : 'no'}`);
  }
}

/**
 * Read all of stdin into a string (for piped / heredoc input).
 */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

export async function shellSendCommand(
  shellId: number,
  options: {
    data?: string;
    signal?: string;
  },
): Promise<void> {
  if (options.data !== undefined && options.signal) {
    console.error('--data and --signal are mutually exclusive');
    process.exit(1);
  }

  let data: string;
  if (options.signal) {
    const sigName = options.signal.toUpperCase();
    const byte = SIGNAL_MAP[sigName];
    if (!byte) {
      console.error(`Unknown signal: ${options.signal}. Supported: ${Object.keys(SIGNAL_MAP).join(', ')}`);
      process.exit(1);
    }
    data = byte;
  } else if (options.data !== undefined) {
    data = unescapeData(options.data);
  } else if (!process.stdin.isTTY) {
    data = await readStdin();
  } else {
    console.error('Provide --data <value>, --signal <name>, or pipe data via stdin');
    process.exit(1);
  }

  const client = await findShellDaemon(shellId);

  try {
    await client.shellSend(shellId, data);
  } finally {
    client.close();
  }
}

/**
 * Shared interactive session loop — enters raw mode and proxies I/O between
 * the local terminal and the daemon's shell WebSocket.
 */
async function runShellSession(client: DaemonClient, shellId: number): Promise<void> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  if (!stdin.isTTY) {
    console.error('Shell requires a TTY. Use -b for background mode in non-TTY environments.');
    client.close();
    process.exit(1);
  }

  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  const DETACH_CHAR = '\x1c'; // Ctrl+\

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    stdin.removeListener('data', onData);
    process.removeListener('SIGWINCH', onResize);
    stdin.setRawMode(wasRaw);
    stdin.pause();
  };

  const onData = (data: string) => {
    if (data === DETACH_CHAR) {
      cleanup();
      console.error(`\r\n[detached from shell ${shellId} — use 'colab shell attach ${shellId}' to resume]`);
      client.shellDetach(shellId);
      client.close();
      return;
    }
    client.shellInput(shellId, data);
  };

  const onResize = () => {
    client.shellResize(shellId, stdout.columns, stdout.rows);
  };

  stdin.on('data', onData);
  process.on('SIGWINCH', onResize);

  try {
    for await (const msg of client.shellStream()) {
      if (msg.type === 'shell_output') {
        stdout.write(msg.data);
      } else if (msg.type === 'shell_closed') {
        console.error(`\r\n[shell ${shellId} closed: ${msg.reason}]`);
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\r\n[shell connection lost: ${message}]`);
  } finally {
    cleanup();
    client.close();
  }
}
