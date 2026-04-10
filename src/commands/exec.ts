import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { ColabClient } from '../colab/client.js';
import { handleEphemeralAuth } from '../auth/ephemeral.js';
import { DaemonClient } from '../daemon/client.js';
import { renderOutput, renderStream } from '../output/terminal-renderer.js';
import { RuntimeManager } from '../runtime/runtime-manager.js';
import { createSpinner, isJsonMode, setJsonMode } from '../output/json-output.js';

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

/**
 * Resolve a user-supplied output dir to an absolute path using the CLI's
 * own CWD. The daemon is a long-running background process whose CWD is
 * almost never the same as the user's terminal CWD, so relative paths
 * MUST be resolved on the CLI side before being sent over IPC.
 *
 * Also expands a leading `~` (which the shell normally handles, but not
 * when the user quotes the path).
 */
function resolveOutputDir(dir: string): string {
  let expanded = dir;
  if (expanded === '~') {
    expanded = os.homedir();
  } else if (expanded.startsWith('~/')) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  return path.resolve(process.cwd(), expanded);
}

export async function execCommand(
  runtimeManager: RuntimeManager,
  colabClient: ColabClient,
  options: {
    code?: string;
    file?: string;
    endpoint?: string;
    outputDir?: string;
  },
): Promise<void> {
  let code: string;
  if (options.file) {
    code = fs.readFileSync(options.file, 'utf-8');
  } else if (options.code) {
    code = options.code;
  } else {
    console.error('Provide code as argument or use -f <file>');
    process.exit(1);
  }

  if (isJsonMode()) {
    console.error('Warning: --json is not supported for `exec` and will be ignored.');
    setJsonMode(false);
  }

  const absoluteOutputDir = options.outputDir
    ? resolveOutputDir(options.outputDir)
    : undefined;

  const server = options.endpoint
    ? runtimeManager.getServerByEndpoint(options.endpoint)
    : runtimeManager.getLatestServer();
  if (!server) {
    console.error('No runtime found. Create one first with `colab runtime create`.');
    process.exit(1);
  }

  const spinner = createSpinner('Connecting to daemon...').start();
  const client = new DaemonClient();
  try {
    await client.connect(server.id);
    spinner.stop();
  } catch (err) {
    spinner.fail('Failed to connect to daemon');
    throw err;
  }

  // Override SIGINT: interrupt kernel instead of exiting process.
  // First Ctrl+C sends interrupt to kernel; second Ctrl+C force-exits.
  const origSigint = process.rawListeners('SIGINT').slice();
  process.removeAllListeners('SIGINT');
  let interrupted = false;
  const doInterrupt = () => {
    if (interrupted) process.exit(1);
    interrupted = true;
    client.interrupt();
  };
  process.on('SIGINT', doInterrupt);

  let hasError = false;
  try {
    const outputs = client.exec(code, {
      outputDir: absoluteOutputDir,
      handleEphemeralAuth: async (authType) => {
        await handleEphemeralAuth(colabClient, server.endpoint, authType, server.label);
      },
      handleStdinRequest: async (prompt, password) => {
        if (!process.stdin.isTTY) return '';
        if (password) {
          return readPassword(prompt, process.stdout, doInterrupt);
        }
        return readLine(prompt, process.stdout, doInterrupt);
      },
    });
    hasError = await renderStream(outputs);
  } finally {
    process.removeAllListeners('SIGINT');
    for (const fn of origSigint) {
      process.on('SIGINT', fn as (...args: any[]) => void);
    }
    client.close();
  }

  if (hasError) {
    process.exitCode = 1;
  }
}

export async function execBgCommand(
  runtimeManager: RuntimeManager,
  options: {
    code?: string;
    file?: string;
    endpoint?: string;
    outputDir?: string;
  },
): Promise<void> {
  let code: string;
  if (options.file) {
    code = fs.readFileSync(options.file, 'utf-8');
  } else if (options.code) {
    code = options.code;
  } else {
    console.error('Provide code as argument or use -f <file>');
    process.exit(1);
  }

  const absoluteOutputDir = options.outputDir
    ? resolveOutputDir(options.outputDir)
    : undefined;

  const server = options.endpoint
    ? runtimeManager.getServerByEndpoint(options.endpoint)
    : runtimeManager.getLatestServer();
  if (!server) {
    console.error('No runtime found. Create one first with `colab runtime create`.');
    process.exit(1);
  }

  const spinner = createSpinner('Connecting to daemon...').start();
  const client = new DaemonClient();
  try {
    await client.connect(server.id);
    spinner.stop();
  } catch (err) {
    spinner.fail('Failed to connect to daemon');
    throw err;
  }

  try {
    const execId = await client.execBackground(code, absoluteOutputDir);
    // Print just the exec ID to stdout for scripting
    console.log(execId);
  } finally {
    client.close();
  }
}

export async function execAttachCommand(
  runtimeManager: RuntimeManager,
  colabClient: ColabClient,
  execId: number,
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
      const result = await client.execAttachSnapshot(execId, options.tail);
      for (const output of result.outputs) {
        renderOutput(output);
      }
      if (result.pendingInput) {
        console.error(`[waiting for input: "${result.pendingInput.prompt}"]`);
      }
      if (result.pendingAuth) {
        if (result.pendingAuth.authUrl) {
          console.error('[waiting for authorization — visit the URL below; execution will resume automatically after authorization completes]');
          console.error(`[auth url: ${result.pendingAuth.authUrl}]`);
        } else {
          console.error(`[waiting for authorization — run 'colab exec attach ${execId}' to complete]`);
        }
      }
      console.error(`[status: ${result.status}]`);
      if (result.outputs.some((o) => o.type === 'error')) {
        process.exitCode = 1;
      }
    } finally {
      client.close();
    }
    return;
  }

  // Streaming attach — same UX as foreground exec
  const origSigint = process.rawListeners('SIGINT').slice();
  process.removeAllListeners('SIGINT');
  let interrupted = false;
  const doInterrupt = () => {
    if (interrupted) process.exit(1);
    interrupted = true;
    client.interrupt();
  };
  process.on('SIGINT', doInterrupt);

  let hasError = false;
  try {
    const outputs = client.execAttach(execId, {
      handleEphemeralAuth: async (authType) => {
        await handleEphemeralAuth(colabClient, server.endpoint, authType, server.label);
      },
      handleStdinRequest: async (prompt, password) => {
        if (!process.stdin.isTTY) return '';
        if (password) {
          return readPassword(prompt, process.stdout, doInterrupt);
        }
        return readLine(prompt, process.stdout, doInterrupt);
      },
    });
    hasError = await renderStream(outputs);
  } finally {
    process.removeAllListeners('SIGINT');
    for (const fn of origSigint) {
      process.on('SIGINT', fn as (...args: any[]) => void);
    }
    client.close();
  }

  if (hasError) {
    process.exitCode = 1;
  }
}

export async function execListCommand(
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
    const executions = await client.execList();
    if (executions.length === 0) {
      console.log('No executions.');
      return;
    }

    // Print table
    const header = 'ID\tSTATUS\tELAPSED\tSTARTED\t\t\t\tOUTPUTS\tCODE';
    console.log(header);
    for (const e of executions) {
      const started = new Date(e.startedAt).toLocaleString();
      const codeSnippet = e.code.replace(/\n/g, '\\n');
      const endMs = e.finishedAt ? new Date(e.finishedAt).getTime() : Date.now();
      const elapsed = formatElapsed(endMs - new Date(e.startedAt).getTime());
      console.log(`${e.execId}\t${e.status}\t${elapsed}\t${started}\t${e.outputCount}\t${codeSnippet}`);
    }
  } finally {
    client.close();
  }
}

export async function execSendCommand(
  runtimeManager: RuntimeManager,
  execId: number,
  options: {
    endpoint?: string;
    stdin?: string;
    interrupt?: boolean;
  },
): Promise<void> {
  if (options.stdin === undefined && !options.interrupt) {
    console.error('Provide --stdin <value> or --interrupt');
    process.exit(1);
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
    client.execSend(execId, {
      stdin: options.stdin,
      interrupt: options.interrupt,
    });
  } finally {
    client.close();
  }
}

export async function execClearCommand(
  runtimeManager: RuntimeManager,
  execId: number | undefined,
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
    const count = await client.execClear(execId);
    if (execId !== undefined) {
      console.log(count ? `Cleared execution ${execId}.` : `Execution ${execId} not found or still running.`);
    } else {
      console.log(`Cleared ${count} execution${count !== 1 ? 's' : ''}.`);
    }
  } finally {
    client.close();
  }
}

function readLine(
  prompt: string,
  output: NodeJS.WritableStream,
  onInterrupt: () => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: output as NodeJS.WritableStream & { fd?: number },
      terminal: process.stdin.isTTY,
    });
    let settled = false;
    rl.question(prompt, (answer) => {
      if (!settled) {
        settled = true;
        rl.close();
        resolve(answer);
      }
    });
    // Ctrl+C: interrupt kernel, reject so no input_reply is sent
    rl.on('SIGINT', () => {
      if (!settled) {
        settled = true;
        rl.close();
        onInterrupt();
        reject(new Error('interrupted'));
      }
    });
    // Ctrl+D (EOF): send empty string as input
    rl.on('close', () => {
      if (!settled) {
        settled = true;
        resolve('');
      }
    });
  });
}

function readPassword(
  prompt: string,
  output: NodeJS.WritableStream,
  onInterrupt: () => void,
): Promise<string> {
  output.write(prompt);

  if (!process.stdin.isTTY) {
    output.write('\n');
    return Promise.resolve('');
  }

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let input = '';

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      output.write('\n');
    };

    const onData = (data: string) => {
      for (const char of data) {
        switch (char) {
          case '\r':
          case '\n':
          case '\u0004': // Ctrl+D / EOF
            cleanup();
            resolve(input);
            return;
          case '\u0003': // Ctrl+C — interrupt kernel, reject so no input_reply is sent
            cleanup();
            onInterrupt();
            reject(new Error('interrupted'));
            return;
          case '\u007f':
          case '\b': // Backspace
            input = input.slice(0, -1);
            break;
          default:
            input += char;
            break;
        }
      }
    };

    stdin.on('data', onData);
  });
}
