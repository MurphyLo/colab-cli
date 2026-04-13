import { DaemonClient } from '../daemon/client.js';
import { RuntimeManager } from '../runtime/runtime-manager.js';
import { createSpinner } from '../output/json-output.js';

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

export async function shellCommand(
  runtimeManager: RuntimeManager,
  options: {
    endpoint?: string;
    background?: boolean;
  },
): Promise<void> {
  const server = options.endpoint
    ? runtimeManager.getServerByEndpoint(options.endpoint)
    : runtimeManager.getLatestServer();
  if (!server) {
    console.error('No runtime found. Create one first with `colab runtime create`.');
    process.exit(1);
  }

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

  let shellId: number;
  try {
    shellId = await client.shellOpen(cols, rows);
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
  runtimeManager: RuntimeManager,
  shellId: number,
  options: {
    endpoint?: string;
    noWait?: boolean;
    tail?: number;
  },
): Promise<void> {
  const server = options.endpoint
    ? runtimeManager.getServerByEndpoint(options.endpoint)
    : runtimeManager.getLatestServer();
  if (!server) {
    console.error('No runtime found. Create one first with `colab runtime create`.');
    process.exit(1);
  }

  const client = new DaemonClient();
  await client.connect(server.id);

  // --tail implies --no-wait
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

export async function shellListCommand(
  runtimeManager: RuntimeManager,
  options: { endpoint?: string },
): Promise<void> {
  const server = options.endpoint
    ? runtimeManager.getServerByEndpoint(options.endpoint)
    : runtimeManager.getLatestServer();
  if (!server) {
    console.error('No runtime found. Create one first with `colab runtime create`.');
    process.exit(1);
  }

  const client = new DaemonClient();
  await client.connect(server.id);

  try {
    const shells = await client.shellList();
    if (shells.length === 0) {
      console.log('No shell sessions.');
      return;
    }

    const header = 'ID\tSTATUS\tSTARTED\t\t\t\tATTACHED';
    console.log(header);
    for (const s of shells) {
      const started = new Date(s.startedAt).toLocaleString();
      console.log(`${s.shellId}\t${s.status}\t${started}\t${s.attached ? 'yes' : 'no'}`);
    }
  } finally {
    client.close();
  }
}

export async function shellSendCommand(
  runtimeManager: RuntimeManager,
  shellId: number,
  options: {
    endpoint?: string;
    data?: string;
    signal?: string;
  },
): Promise<void> {
  if (options.data === undefined && !options.signal) {
    console.error('Provide --data <value> or --signal <name>');
    process.exit(1);
  }
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
  } else {
    data = unescapeData(options.data!);
  }

  const server = options.endpoint
    ? runtimeManager.getServerByEndpoint(options.endpoint)
    : runtimeManager.getLatestServer();
  if (!server) {
    console.error('No runtime found. Create one first with `colab runtime create`.');
    process.exit(1);
  }

  const client = new DaemonClient();
  await client.connect(server.id);

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
