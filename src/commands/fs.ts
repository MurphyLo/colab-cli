import fs from 'fs';
import path from 'path';
import { DaemonClient } from '../daemon/client.js';
import { createSpinner, isJsonMode, jsonResult } from '../output/json-output.js';
import { RuntimeManager } from '../runtime/runtime-manager.js';
import { getStoredServer, type StoredServer } from '../runtime/storage.js';
import { type ConnectionProvider, chooseStrategy, formatBytes } from '../transfer/common.js';
import { uploadFile, type UploadProgressEvent } from '../transfer/upload.js';
import { downloadFile, type DownloadProgressEvent } from '../transfer/download.js';

function resolveServer(
  runtimeManager: RuntimeManager,
  endpoint?: string,
): StoredServer {
  const server = endpoint
    ? runtimeManager.getServerByEndpoint(endpoint)
    : runtimeManager.getLatestServer();
  if (!server) {
    console.error('No runtime found. Create one first with `colab runtime create`.');
    process.exit(1);
  }
  return server;
}

function makeConnectionProvider(server: StoredServer): ConnectionProvider {
  return {
    getProxyUrl() {
      return getStoredServer(server.id)?.proxyUrl ?? server.proxyUrl;
    },
    getToken() {
      return getStoredServer(server.id)?.token ?? server.token;
    },
  };
}

function makeDaemonExec(client: DaemonClient): (code: string) => Promise<string> {
  return async (code: string): Promise<string> => {
    const outputs = client.exec(code);
    const textParts: string[] = [];
    for await (const output of outputs) {
      if (output.type === 'stream' && output.text) {
        textParts.push(output.text);
      }
    }
    return textParts.join('');
  };
}

// --- Upload command ---

export async function fsUploadCommand(
  runtimeManager: RuntimeManager,
  options: { localPath: string; remotePath?: string; endpoint?: string },
): Promise<void> {
  const resolvedPath = path.resolve(options.localPath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`File not found: ${resolvedPath}`);
    process.exit(1);
  }
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    console.error(`Not a file: ${resolvedPath}`);
    process.exit(1);
  }

  const server = resolveServer(runtimeManager, options.endpoint);
  const conn = makeConnectionProvider(server);
  const strategy = chooseStrategy(stat.size);

  let daemonClient: DaemonClient | undefined;
  let execOnKernel: (code: string) => Promise<string>;

  if (strategy === 'chunked') {
    daemonClient = new DaemonClient();
    await daemonClient.connect(server.id);
    execOnKernel = makeDaemonExec(daemonClient);
  } else {
    execOnKernel = async () => '';
  }

  const spinner = createSpinner('Uploading...').start();
  const onProgress = (event: UploadProgressEvent): void => {
    switch (event.type) {
      case 'start':
        spinner.text = `Uploading ${path.basename(event.localPath)} (${formatBytes(event.sizeBytes)}, ${event.strategy})...`;
        break;
      case 'uploading':
        spinner.text = event.message;
        break;
      case 'chunk-progress':
        spinner.text = `Uploading chunks: ${event.uploaded}/${event.total}`;
        break;
      case 'assembling':
        spinner.text = 'Assembling chunks on runtime...';
        break;
      case 'verifying':
        spinner.text = 'Verifying upload...';
        break;
      case 'done':
        break;
    }
  };

  try {
    const result = await uploadFile(conn, {
      localPath: resolvedPath,
      remotePath: options.remotePath,
    }, execOnKernel, onProgress);
    if (isJsonMode()) {
      jsonResult({ command: 'fs.upload', localPath: result.localPath, remotePath: result.remotePath, sizeBytes: result.sizeBytes });
    } else {
      spinner.succeed(`Uploaded ${path.basename(result.localPath)} -> /${result.remotePath} (${formatBytes(result.sizeBytes)})`);
    }
  } catch (err) {
    spinner.fail('Upload failed');
    throw err;
  } finally {
    daemonClient?.close();
  }
}

// --- Download command ---

export async function fsDownloadCommand(
  runtimeManager: RuntimeManager,
  options: { remotePath: string; localPath?: string; endpoint?: string },
): Promise<void> {
  const server = resolveServer(runtimeManager, options.endpoint);
  const conn = makeConnectionProvider(server);

  // We don't know the file size yet (need metadata first), so always prepare daemon.
  // Connect lazily only if chunked strategy is needed.
  let daemonClient: DaemonClient | undefined;
  const getExecOnKernel = async (): Promise<(code: string) => Promise<string>> => {
    if (!daemonClient) {
      daemonClient = new DaemonClient();
      await daemonClient.connect(server.id);
    }
    return makeDaemonExec(daemonClient);
  };

  // Wrap execOnKernel to lazily connect
  let execOnKernelCached: ((code: string) => Promise<string>) | undefined;
  const execOnKernel = async (code: string): Promise<string> => {
    if (!execOnKernelCached) {
      execOnKernelCached = await getExecOnKernel();
    }
    return execOnKernelCached(code);
  };

  const spinner = createSpinner('Downloading...').start();
  const onProgress = (event: DownloadProgressEvent): void => {
    switch (event.type) {
      case 'start':
        spinner.text = `Downloading /${event.remotePath} (${formatBytes(event.sizeBytes)}, ${event.strategy})...`;
        break;
      case 'downloading':
        spinner.text = event.message;
        break;
      case 'splitting':
        spinner.text = 'Splitting file into chunks on runtime...';
        break;
      case 'chunk-progress':
        spinner.text = `Downloading chunks: ${event.downloaded}/${event.total}`;
        break;
      case 'writing':
        spinner.text = `Writing ${formatBytes(event.sizeBytes)} to ${event.localPath}...`;
        break;
      case 'done':
        break;
    }
  };

  try {
    const result = await downloadFile(conn, {
      remotePath: options.remotePath,
      localPath: options.localPath,
    }, execOnKernel, onProgress);
    if (isJsonMode()) {
      jsonResult({ command: 'fs.download', remotePath: result.remotePath, localPath: result.localPath, sizeBytes: result.sizeBytes });
    } else {
      spinner.succeed(`Downloaded /${result.remotePath} -> ${result.localPath} (${formatBytes(result.sizeBytes)})`);
    }
  } catch (err) {
    spinner.fail('Download failed');
    throw err;
  } finally {
    daemonClient?.close();
  }
}
