/**
 * Kaggle mode: entered from index.ts when COLAB_KAGGLE_URL is set.
 *
 * Implements a subset of the Colab command tree with the same names and
 * options against a Kaggle notebook session's Jupyter server. Everything not
 * listed in SUPPORTED is rejected, so new Colab commands are never reachable
 * in Kaggle mode by accident.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { Writable } from 'stream';
import chalk from 'chalk';
import { Command } from 'commander';
import { log } from '../logging/index.js';
import { printResources } from '../commands/runtime.js';
import { saveOutputImages } from '../daemon/image-saver.js';
import { createSpinner, isJsonMode, jsonError, jsonResult, setJsonMode } from '../output/json-output.js';
import { renderOutput } from '../output/terminal-renderer.js';
import { createForwarder } from '../port-forward/forwarder.js';
import type { PortTokenRefresher } from '../port-forward/token-refresher.js';
import { getTlsCredentials } from '../port-forward/tls.js';
import { getContentsMetadata, isFileModel } from '../jupyter/contents-client.js';
import { DIRECT_LIMIT_BYTES, formatBytes, normalizeRemotePath } from '../transfer/common.js';
import { downloadFile, type DownloadProgressEvent } from '../transfer/download.js';
import { uploadFile, type UploadProgressEvent } from '../transfer/upload.js';
import { KaggleSession } from './session.js';
import { KAGGLE_URL_ENV, resolveKaggleTarget } from './url.js';

const SUPPORTED: Record<string, readonly string[] | null> = {
  exec: null,
  fs: ['upload', 'download'],
  'port-forward': ['create'],
  pf: ['create'],
  runtime: ['list', 'restart', 'resources'],
};
const EXEC_SUBCOMMANDS = new Set(['attach', 'list', 'send', 'clear']);

/**
 * Return a description of why argv cannot run in Kaggle mode, or undefined
 * when it can (including help requests, which commander handles).
 */
export function rejectUnsupported(args: readonly string[]): string | undefined {
  if (args.some((a) => a === '-e' || a === '--endpoint' || a.startsWith('--endpoint='))) {
    return '`-e/--endpoint` cannot be used in Kaggle mode; the target is always the session in ' + KAGGLE_URL_ENV;
  }
  const words = args.filter((a) => !a.startsWith('-'));
  const [command, sub] = words;
  if (command === undefined || command === 'help') return undefined;
  if (!(command in SUPPORTED)) return unsupported(command);

  const subs = SUPPORTED[command];
  if (command === 'exec') {
    const next = args[args.indexOf('exec') + 1];
    if (next !== undefined && EXEC_SUBCOMMANDS.has(next)) return unsupported(`exec ${next}`);
    if (args.includes('-b') || args.includes('--background')) return unsupported('exec --background');
    return undefined;
  }
  if (sub === undefined || sub === 'help' || subs!.includes(sub)) return undefined;
  return unsupported(`${command} ${sub}`);
}

function unsupported(name: string): string {
  return `\`${name}\` is not supported in Kaggle mode (${KAGGLE_URL_ENV} is set). Unset ${KAGGLE_URL_ENV} to use Colab.`;
}

export async function runKaggleCli(argv: string[] = process.argv): Promise<void> {
  const args = argv.slice(2);
  if (args.includes('--json')) setJsonMode(true);
  try {
    const reason = rejectUnsupported(args);
    if (reason) throw new Error(reason);
    await buildProgram().parseAsync(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isJsonMode()) jsonError(message);
    else console.error(`Error: ${message}`);
    log.debug(err instanceof Error ? err.stack : undefined);
    process.exit(1);
  }
}

let sessionPromise: Promise<KaggleSession> | undefined;

/** Resolve the target once per invocation and announce it on stderr. */
function getSession(): Promise<KaggleSession> {
  sessionPromise ??= resolveKaggleTarget(process.env[KAGGLE_URL_ENV] ?? '').then((target) => {
    console.error(chalk.dim(`[kaggle] session ${target.sessionId}`));
    return new KaggleSession(target);
  });
  return sessionPromise;
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name('colab')
    .description(`Kaggle mode (${KAGGLE_URL_ENV} is set): run code and move files on a Kaggle notebook session`)
    .allowExcessArguments(false)
    .option('--verbose', 'enable verbose logging')
    .option('--json', 'output results as JSON to stdout (for scripting)')
    .hook('preAction', (cmd) => {
      const opts = cmd.opts();
      if (opts.verbose) log.setVerbose(true);
      if (opts.json) setJsonMode(true);
    });

  program
    .command('exec [code]')
    .description('execute code on the Kaggle session (state persists between calls)')
    .option('-f, --file <path>', 'execute code from a file. Omit both [code] and -f to read code from piped stdin/heredoc')
    .option('-o, --output-dir <path>', 'save image outputs (png, jpeg, gif, svg) to this directory')
    .action((code, opts) => execAction(code, opts));

  const runtime = program.command('runtime').description('inspect the Kaggle session');
  runtime.command('list').description('show the Kaggle session and the CLI kernel').action(runtimeListAction);
  runtime.command('restart').description("restart the CLI's kernel").action(runtimeRestartAction);
  runtime.command('resources').description('show RAM, disk and GPU usage').action(runtimeResourcesAction);

  const portForward = program
    .command('port-forward')
    .alias('pf')
    .description('forward a session port to a local bind address (HTTP/WebSocket)');
  portForward
    .command('create <spec>')
    .description('forward in the foreground until Ctrl+C; spec is REMOTE, LOCAL:REMOTE, or HOST:LOCAL:REMOTE')
    .option('--tls', 'serve locally over HTTPS with a self-signed certificate')
    .action((spec, opts) => portForwardAction(spec, opts));

  const fsCmd = program.command('fs').description('transfer files to and from the session');
  fsCmd
    .command('upload <local-path>')
    .description('upload a file (up to 20 MiB) to the session')
    .option('-r, --remote-path <path>', 'remote destination path (default: content/<filename>, i.e. /content/<filename>)')
    .action((localPath, opts) => uploadAction(localPath, opts));
  fsCmd
    .command('download <remote-path>')
    .description('download a file (up to 20 MiB) from the session')
    .option('-o, --output <path>', 'local destination path (default: ./<filename>)')
    .action((remotePath, opts) => downloadAction(remotePath, opts));

  return program;
}

// --- exec ---

async function execAction(
  codeArg: string | undefined,
  opts: { file?: string; outputDir?: string },
): Promise<void> {
  let code: string;
  if (opts.file) code = fs.readFileSync(opts.file, 'utf-8');
  else if (codeArg) code = codeArg;
  else if (!process.stdin.isTTY) code = await readStdin();
  else throw new Error('Provide code as argument, use -f <file>, or pipe code via stdin');

  if (isJsonMode()) {
    console.error('Warning: --json is not supported for `exec` and will be ignored.');
    setJsonMode(false);
  }
  const outputDir = opts.outputDir ? resolveUserPath(opts.outputDir) : undefined;

  const session = await getSession();
  const kernel = await session.openKernel();

  // First Ctrl+C interrupts the kernel; the second exits.
  const origSigint = process.rawListeners('SIGINT').slice();
  process.removeAllListeners('SIGINT');
  let interrupted = false;
  const doInterrupt = () => {
    if (interrupted) process.exit(1);
    interrupted = true;
    void kernel.interrupt().catch((err) => log.error('Interrupt failed:', String(err)));
  };
  process.on('SIGINT', doInterrupt);
  // `timeout`, agent tools and supervisors stop exec with SIGTERM. Exiting
  // without an interrupt would leave the code running in the shared kernel,
  // blocking every later call, and report success.
  const origSigterm = process.rawListeners('SIGTERM').slice();
  process.removeAllListeners('SIGTERM');
  process.on('SIGTERM', () => {
    const deadline = new Promise((resolve) => setTimeout(resolve, 5_000));
    void Promise.race([kernel.interrupt(), deadline])
      .catch((err) => log.error('Interrupt failed:', String(err)))
      .finally(() => process.exit(143));
  });

  const imageExecId = Math.floor(Date.now() / 1000);
  let imageCounter = 0;
  let hasError = false;
  try {
    for await (let output of await kernel.execute(code)) {
      if (output.type === 'input_request') {
        const value = await promptInput(output.prompt, output.password, doInterrupt).catch(() => undefined);
        if (value !== undefined) await kernel.sendStdinReply(value);
        continue;
      }
      if (outputDir) {
        const saved = saveOutputImages(output, imageExecId, outputDir, imageCounter);
        output = saved.output;
        imageCounter = saved.nextCounter;
      }
      renderOutput(output);
      if (output.type === 'error') hasError = true;
    }
  } finally {
    process.removeAllListeners('SIGINT');
    for (const fn of origSigint) process.on('SIGINT', fn as (...args: any[]) => void);
    process.removeAllListeners('SIGTERM');
    for (const fn of origSigterm) process.on('SIGTERM', fn as (...args: any[]) => void);
    await session.closeKernel(kernel);
  }
  if (hasError) process.exitCode = 1;
}

// --- runtime ---

async function runtimeListAction(): Promise<void> {
  const session = await getSession();
  const [status, cli] = await Promise.all([session.status(), session.findCliSession()]);
  const cliKernel = cli?.kernel ? { id: cli.kernel.id, state: cli.kernel.execution_state ?? 'unknown' } : null;
  if (isJsonMode()) {
    jsonResult({
      command: 'runtime.list',
      runtimes: [{
        endpoint: session.endpoint,
        kind: 'kaggle',
        sessionId: session.target.sessionId,
        started: status.started,
        lastActivity: status.last_activity,
        kernels: status.kernels,
        cliKernel,
      }],
    });
    return;
  }
  console.log(`${chalk.bold('Kaggle session')} ${session.target.sessionId}`);
  console.log(`  started:       ${new Date(status.started).toLocaleString()}`);
  console.log(`  last activity: ${new Date(status.last_activity).toLocaleString()}`);
  console.log(`  kernels:       ${status.kernels}`);
  console.log(`  CLI kernel:    ${cliKernel ? `${cliKernel.id} (${cliKernel.state})` : 'none (created on first exec)'}`);
}

async function runtimeRestartAction(): Promise<void> {
  const session = await getSession();
  const spinner = createSpinner('Restarting kernel...').start();
  try {
    const restarted = await session.restartCliKernel();
    if (isJsonMode()) jsonResult({ command: 'runtime.restart', endpoint: session.endpoint, restarted });
    else spinner.succeed(restarted ? 'Kernel restarted' : 'No CLI kernel yet; nothing to restart');
  } catch (err) {
    spinner.fail('Failed to restart kernel');
    throw err;
  }
}

async function runtimeResourcesAction(): Promise<void> {
  const session = await getSession();
  const resources = await session.resources();
  if (isJsonMode()) {
    jsonResult({ command: 'runtime.resources', endpoint: session.endpoint, ...resources });
    return;
  }
  printResources(resources);
}

// --- port-forward ---

export function parseForwardSpec(spec: string): { localHost: string; localPort: number; remotePort: number } {
  const parts = spec.split(':');
  const port = (s: string) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Invalid port "${s}" (must be 1-65535)`);
    return n;
  };
  if (parts.length === 1) return { localHost: '127.0.0.1', localPort: port(parts[0]), remotePort: port(parts[0]) };
  if (parts.length === 2) return { localHost: '127.0.0.1', localPort: port(parts[0]), remotePort: port(parts[1]) };
  if (parts.length === 3 && parts[0]) return { localHost: parts[0], localPort: port(parts[1]), remotePort: port(parts[2]) };
  throw new Error(`Invalid spec "${spec}". Use REMOTE, LOCAL:REMOTE, or HOST:LOCAL:REMOTE.`);
}

async function portForwardAction(spec: string, opts: { tls?: boolean }): Promise<void> {
  const { localHost, localPort, remotePort } = parseForwardSpec(spec);
  const session = await getSession();
  await session.status();

  // jupyter-server-proxy exposes session ports under <base>/proxy/<port>;
  // the token is static, so a plain object stands in for the refresher.
  const proxyUrl = `${session.base}/proxy/${remotePort}`;
  const target = { token: session.connection.getToken(), proxyUrl } as unknown as PortTokenRefresher;
  const tls = opts.tls ? await getTlsCredentials() : undefined;
  const server = createForwarder(target, tls);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(localPort, localHost, () => {
      server.off('error', reject);
      resolve();
    });
  });

  if (isJsonMode()) {
    jsonResult({ localHost, localPort, remotePort, tls: !!tls, foreground: true });
  } else {
    const scheme = tls ? 'https' : 'http';
    console.log(`bind ${scheme}://${localHost}:${localPort} → kaggle:${remotePort}`);
    console.error(chalk.dim('Forwarding in the foreground; press Ctrl+C to stop.'));
  }
  // Runs until SIGINT/SIGTERM, which index.ts maps to process.exit(0).
  await new Promise<never>(() => {});
}

// --- fs ---
//
// Kaggle mode only does single-request ("direct") transfers. Larger files go
// through Kaggle Datasets instead of the chunked Contents API path.

const NO_KERNEL = async (): Promise<string> => {
  throw new Error('chunked transfer is not available in Kaggle mode');
};

function tooLarge(what: string, sizeBytes: number, hint: string): Error {
  return new Error(
    `${what} is ${sizeBytes} bytes; Kaggle mode only transfers files up to ` +
      `${DIRECT_LIMIT_BYTES} bytes (20 MiB). ${hint}`,
  );
}

async function uploadAction(localPath: string, opts: { remotePath?: string }): Promise<void> {
  const resolved = path.resolve(localPath);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`Not a file: ${resolved}`);
  if (stat.size > DIRECT_LIMIT_BYTES) {
    throw tooLarge(path.basename(resolved), stat.size,
      'Publish it with `kaggle datasets create/version` locally, then mount it with ' +
        '`colab exec "import kagglehub; print(kagglehub.dataset_download(\'<owner>/<slug>\'))"`.');
  }

  const session = await getSession();
  await session.ensureLayout();

  const spinner = createSpinner('Uploading...').start();
  const onProgress = (event: UploadProgressEvent): void => {
    if (event.type === 'start') spinner.text = `Uploading ${path.basename(event.localPath)} (${formatBytes(event.sizeBytes)})...`;
    else if (event.type === 'uploading') spinner.text = event.message;
    else if (event.type === 'verifying') spinner.text = 'Verifying upload...';
  };
  try {
    const result = await uploadFile(session.connection, { localPath: resolved, remotePath: opts.remotePath }, NO_KERNEL, onProgress);
    if (isJsonMode()) {
      jsonResult({ command: 'fs.upload', localPath: result.localPath, remotePath: result.remotePath, sizeBytes: result.sizeBytes });
    } else {
      spinner.succeed(`Uploaded ${path.basename(result.localPath)} -> /${result.remotePath} (${formatBytes(result.sizeBytes)})`);
    }
  } catch (err) {
    spinner.fail('Upload failed');
    throw err;
  }
}

async function downloadAction(remotePath: string, opts: { output?: string }): Promise<void> {
  const session = await getSession();
  await session.ensureLayout();

  const contentsPath = normalizeRemotePath(remotePath);
  const metadata = await getContentsMetadata(session.base, 'kaggle', contentsPath).catch((err) => {
    if (err?.status === 404) throw new Error(`Remote file not found: /${contentsPath}`);
    throw err;
  });
  if (!isFileModel(metadata)) throw new Error(`Remote path is not a file: /${contentsPath}`);
  const size = Number(metadata.size);
  if (size > DIRECT_LIMIT_BYTES) {
    throw tooLarge(`/${contentsPath}`, size,
      'Publish it from the session with `kaggle datasets create/version` (via colab exec), ' +
        'then fetch it locally with `kaggle datasets download`.');
  }

  const spinner = createSpinner('Downloading...').start();
  const onProgress = (event: DownloadProgressEvent): void => {
    if (event.type === 'start') spinner.text = `Downloading /${event.remotePath} (${formatBytes(event.sizeBytes)})...`;
    else if (event.type === 'downloading') spinner.text = event.message;
    else if (event.type === 'writing') spinner.text = `Writing ${formatBytes(event.sizeBytes)} to ${event.localPath}...`;
  };
  try {
    const result = await downloadFile(session.connection, { remotePath, localPath: opts.output }, NO_KERNEL, onProgress);
    if (isJsonMode()) {
      jsonResult({ command: 'fs.download', remotePath: result.remotePath, localPath: result.localPath, sizeBytes: result.sizeBytes });
    } else {
      spinner.succeed(`Downloaded /${result.remotePath} -> ${result.localPath} (${formatBytes(result.sizeBytes)})`);
    }
  } catch (err) {
    spinner.fail('Download failed');
    throw err;
  }
}

// --- helpers ---

function resolveUserPath(dir: string): string {
  let expanded = dir;
  if (expanded === '~') expanded = os.homedir();
  else if (expanded.startsWith('~/')) expanded = path.join(os.homedir(), expanded.slice(2));
  return path.resolve(process.cwd(), expanded);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/** Answer a kernel input() request; non-interactive callers get ''. */
function promptInput(prompt: string, password: boolean, onInterrupt: () => void): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stdout.write(prompt + '\n');
    return Promise.resolve('');
  }
  return new Promise((resolve, reject) => {
    // For passwords, echo the prompt but swallow the typed characters.
    let muted = false;
    const output = new Writable({
      write(chunk, _encoding, callback) {
        if (!muted) process.stdout.write(chunk);
        callback();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
    let settled = false;
    rl.question(prompt, (answer) => {
      settled = true;
      rl.close();
      if (password) process.stdout.write('\n');
      resolve(answer);
    });
    muted = password;
    rl.on('SIGINT', () => {
      if (settled) return;
      settled = true;
      rl.close();
      onInterrupt();
      reject(new Error('interrupted'));
    });
    rl.on('close', () => {
      if (!settled) {
        settled = true;
        resolve('');
      }
    });
  });
}
