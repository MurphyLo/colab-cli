import fs from 'fs';
import path from 'path';
import {
  getContentsMetadata,
  getFileBase64Content,
} from '../jupyter/contents-client.js';
import { log } from '../logging/index.js';
import {
  type ConnectionProvider,
  type TransferStrategy,
  DEFAULT_CHUNK_SIZE_BYTES,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_RETRIES,
  TMP_ROOT,
  chooseStrategy,
  normalizeRemotePath,
  buildChunkPlan,
  createTransferId,
  sleep,
  runPool,
  ensureRemoteDirectory,
} from './common.js';

export type { ConnectionProvider, TransferStrategy };

// --- Progress ---

export type DownloadProgressEvent =
  | { type: 'start'; strategy: TransferStrategy; remotePath: string; sizeBytes: number }
  | { type: 'downloading'; message: string }
  | { type: 'chunk-progress'; downloaded: number; total: number }
  | { type: 'splitting' }
  | { type: 'writing'; localPath: string; sizeBytes: number }
  | { type: 'done'; localPath: string; sizeBytes: number };

export interface DownloadOptions {
  remotePath: string;
  localPath?: string;
  retries?: number;
  chunkSizeBytes?: number;
  maxConcurrency?: number;
}

export interface DownloadResult {
  remotePath: string;
  localPath: string;
  sizeBytes: number;
  strategy: TransferStrategy;
}

// --- Internal helpers ---

function resolveLocalPath(remotePath: string, localPath?: string): string {
  if (localPath) return path.resolve(localPath);
  return path.resolve(path.basename(remotePath));
}

async function downloadBase64WithRetry(
  conn: ConnectionProvider,
  remotePath: string,
  retries: number,
): Promise<string> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { content } = await getFileBase64Content(conn.getProxyUrl(), conn.getToken(), remotePath);
      return content;
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(1000 * attempt);
    }
  }
  throw new Error(
    `Download failed after ${retries} attempts for ${remotePath}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function buildSplitCode(sourcePath: string, partsDir: string, chunkSizeBytes: number, fileSize: number): string {
  return [
    'import os, json, math',
    `source = ${JSON.stringify(sourcePath)}`,
    `parts_dir = ${JSON.stringify(partsDir)}`,
    `chunk_size = ${chunkSizeBytes}`,
    `file_size = ${fileSize}`,
    'os.makedirs(parts_dir, exist_ok=True)',
    'chunk_count = math.ceil(file_size / chunk_size)',
    'with open(source, "rb") as f:',
    '    for i in range(chunk_count):',
    '        data = f.read(chunk_size)',
    '        name = f"part-{i:06d}"',
    '        with open(os.path.join(parts_dir, name), "wb") as out:',
    '            out.write(data)',
    'print(json.dumps({"ok": True, "chunk_count": chunk_count}))',
  ].join('\n');
}

function buildCleanupCode(tmpDir: string): string {
  return [
    'import shutil',
    `shutil.rmtree(${JSON.stringify(tmpDir)}, ignore_errors=True)`,
    'print("ok")',
  ].join('\n');
}

// --- Download strategies ---

async function downloadDirect(
  conn: ConnectionProvider,
  remotePath: string,
  localPath: string,
  fileSize: number,
  retries: number,
  onProgress?: (event: DownloadProgressEvent) => void,
): Promise<DownloadResult> {
  onProgress?.({ type: 'downloading', message: 'Downloading...' });
  const content = await downloadBase64WithRetry(conn, remotePath, retries);
  const buffer = Buffer.from(content, 'base64');

  onProgress?.({ type: 'writing', localPath, sizeBytes: buffer.length });
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, buffer);

  onProgress?.({ type: 'done', localPath, sizeBytes: buffer.length });
  return { remotePath, localPath, sizeBytes: buffer.length, strategy: 'direct' };
}

async function downloadChunked(
  conn: ConnectionProvider,
  remotePath: string,
  localPath: string,
  fileSize: number,
  retries: number,
  chunkSizeBytes: number,
  maxConcurrency: number,
  execOnKernel: (code: string) => Promise<string>,
  onProgress?: (event: DownloadProgressEvent) => void,
): Promise<DownloadResult> {
  const transferId = createTransferId('download');
  const chunks = buildChunkPlan(fileSize, chunkSizeBytes);
  const tmpDir = `${TMP_ROOT}/${transferId}`;
  const partsDir = `${tmpDir}/parts`;
  const remoteAbsPartsDir = `/${partsDir}`;

  // Split file into chunks on the kernel
  onProgress?.({ type: 'splitting' });
  await ensureRemoteDirectory(conn, 'content');
  await ensureRemoteDirectory(conn, TMP_ROOT);
  const splitOutput = await execOnKernel(buildSplitCode(`/${remotePath}`, remoteAbsPartsDir, chunkSizeBytes, fileSize));
  log.debug('Split output:', splitOutput);

  // Download chunks concurrently
  const chunkBuffers = new Array<Buffer>(chunks.length);
  let downloadedCount = 0;
  await runPool(chunks, maxConcurrency, async (chunk) => {
    const chunkPath = `${partsDir}/${chunk.filename}`;
    const content = await downloadBase64WithRetry(conn, chunkPath, retries);
    chunkBuffers[chunk.index] = Buffer.from(content, 'base64');
    downloadedCount++;
    onProgress?.({ type: 'chunk-progress', downloaded: downloadedCount, total: chunks.length });
  });

  // Write locally
  onProgress?.({ type: 'writing', localPath, sizeBytes: fileSize });
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  const fd = fs.openSync(localPath, 'w');
  try {
    for (const buf of chunkBuffers) {
      fs.writeSync(fd, buf);
    }
  } finally {
    fs.closeSync(fd);
  }

  // Verify local size
  const actualSize = fs.statSync(localPath).size;
  if (actualSize !== fileSize) {
    throw new Error(`Local size mismatch: expected ${fileSize}, got ${actualSize}`);
  }

  // Cleanup remote temp
  try {
    await execOnKernel(buildCleanupCode(`/${tmpDir}`));
  } catch {
    log.debug(`Failed to cleanup remote temp dir: ${tmpDir}`);
  }

  onProgress?.({ type: 'done', localPath, sizeBytes: fileSize });
  return { remotePath, localPath, sizeBytes: fileSize, strategy: 'chunked' };
}

// --- Main entry point ---

export async function downloadFile(
  conn: ConnectionProvider,
  options: DownloadOptions,
  execOnKernel: (code: string) => Promise<string>,
  onProgress?: (event: DownloadProgressEvent) => void,
): Promise<DownloadResult> {
  const remotePath = normalizeRemotePath(options.remotePath);
  const localPath = resolveLocalPath(remotePath, options.localPath);

  // Get file metadata
  const metadata = await getContentsMetadata(conn.getProxyUrl(), conn.getToken(), remotePath);
  if (!metadata || metadata.type !== 'file') {
    throw new Error(`Remote path is not a file: ${remotePath}`);
  }
  const fileSize = Number(metadata.size);
  const strategy = chooseStrategy(fileSize);
  const retries = options.retries ?? DEFAULT_RETRIES;

  onProgress?.({ type: 'start', strategy, remotePath, sizeBytes: fileSize });

  if (strategy === 'drive') {
    throw new Error(
      `File size ${fileSize} bytes exceeds chunked limit. Google Drive download is not yet implemented.`,
    );
  }

  if (strategy === 'direct') {
    return downloadDirect(conn, remotePath, localPath, fileSize, retries, onProgress);
  }

  return downloadChunked(
    conn, remotePath, localPath, fileSize, retries,
    options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES,
    Math.min(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY),
    execOnKernel, onProgress,
  );
}
