import fs from 'fs';
import path from 'path';
import {
  getContentsMetadata,
  putFileBase64,
} from '../jupyter/contents-client.js';
import { log } from '../logging/index.js';
import {
  type ConnectionProvider,
  type TransferStrategy,
  CHUNKED_MAX_BYTES,
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
  ensureRemoteParents,
} from './common.js';

export type { ConnectionProvider, TransferStrategy };

// --- Progress ---

export type UploadProgressEvent =
  | { type: 'start'; strategy: TransferStrategy; localPath: string; remotePath: string; sizeBytes: number }
  | { type: 'uploading'; message: string }
  | { type: 'chunk-progress'; uploaded: number; total: number }
  | { type: 'assembling' }
  | { type: 'verifying' }
  | { type: 'done'; remotePath: string; sizeBytes: number };

export interface UploadOptions {
  localPath: string;
  remotePath?: string;
  retries?: number;
  chunkSizeBytes?: number;
  maxConcurrency?: number;
}

export interface UploadResult {
  ok: boolean;
  strategy: TransferStrategy;
  localPath: string;
  remotePath: string;
  sizeBytes: number;
}

// --- Internal helpers ---

async function verifyUploadedFile(
  conn: ConnectionProvider,
  remotePath: string,
  expectedSize: number,
): Promise<void> {
  const metadata = await getContentsMetadata(conn.getProxyUrl(), conn.getToken(), remotePath);
  if (!metadata || metadata.type !== 'file') {
    throw new Error(`Uploaded path is not a file: ${remotePath}`);
  }
  if (Number(metadata.size) !== expectedSize) {
    throw new Error(`Size mismatch for ${remotePath}: expected ${expectedSize}, got ${metadata.size}`);
  }
}

async function uploadBase64Blob(
  conn: ConnectionProvider,
  remotePath: string,
  base64Content: string,
  expectedSize: number,
  retries: number,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await ensureRemoteParents(conn, remotePath);
      await putFileBase64(conn.getProxyUrl(), conn.getToken(), remotePath, base64Content);
      await verifyUploadedFile(conn, remotePath, expectedSize);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(1000 * attempt);
    }
  }
  throw new Error(
    `Upload failed after ${retries} attempts for ${remotePath}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function readChunkAsBase64(fd: number, offset: number, size: number): string {
  const buffer = Buffer.alloc(size);
  const bytesRead = fs.readSync(fd, buffer, 0, size, offset);
  if (bytesRead !== size) {
    throw new Error(`Short read at offset ${offset}: expected ${size}, got ${bytesRead}`);
  }
  return buffer.toString('base64');
}

function buildAssembleCode(manifestPath: string): string {
  const payload = JSON.stringify({ manifest_path: `/${manifestPath}` });
  return [
    'import json, os, shutil',
    `payload = json.loads(${JSON.stringify(payload)})`,
    'manifest_path = payload["manifest_path"]',
    'with open(manifest_path, "r", encoding="utf-8") as f:',
    '    manifest = json.load(f)',
    'parts_dir = manifest["parts_dir"]',
    'target_tmp = manifest["target_tmp"]',
    'target_final = manifest["target_final"]',
    'expected_size = int(manifest["size_bytes"])',
    'chunk_count = int(manifest["chunk_count"])',
    'part_names = manifest["part_names"]',
    'os.makedirs(os.path.dirname(target_final), exist_ok=True)',
    'if os.path.exists(target_tmp):',
    '    os.remove(target_tmp)',
    'for name in part_names:',
    '    p = os.path.join(parts_dir, name)',
    '    if not os.path.exists(p):',
    '        raise FileNotFoundError(p)',
    'with open(target_tmp, "wb") as out:',
    '    for name in part_names:',
    '        p = os.path.join(parts_dir, name)',
    '        with open(p, "rb") as src:',
    '            shutil.copyfileobj(src, out, length=1024 * 1024)',
    'actual_size = os.path.getsize(target_tmp)',
    'if actual_size != expected_size:',
    '    raise ValueError(f"size mismatch: expected {expected_size}, got {actual_size}")',
    'os.replace(target_tmp, target_final)',
    'shutil.rmtree(parts_dir)',
    'os.remove(manifest_path)',
    'print(json.dumps({"ok": True, "size_bytes": actual_size, "chunk_count": chunk_count}))',
  ].join('\n');
}

// --- Upload strategies ---

async function uploadDirect(
  conn: ConnectionProvider,
  localPath: string,
  remotePath: string,
  fileSize: number,
  retries: number,
  onProgress?: (event: UploadProgressEvent) => void,
): Promise<UploadResult> {
  onProgress?.({ type: 'uploading', message: 'Uploading...' });
  const base64 = fs.readFileSync(localPath).toString('base64');
  await uploadBase64Blob(conn, remotePath, base64, fileSize, retries);
  onProgress?.({ type: 'done', remotePath, sizeBytes: fileSize });
  return { ok: true, strategy: 'direct', localPath, remotePath, sizeBytes: fileSize };
}

async function uploadChunked(
  conn: ConnectionProvider,
  localPath: string,
  remotePath: string,
  fileSize: number,
  retries: number,
  chunkSizeBytes: number,
  maxConcurrency: number,
  execOnKernel: (code: string) => Promise<string>,
  onProgress?: (event: UploadProgressEvent) => void,
): Promise<UploadResult> {
  const transferId = createTransferId('upload');
  const chunks = buildChunkPlan(fileSize, chunkSizeBytes);
  const tmpDir = `${TMP_ROOT}/${transferId}`;
  const partsDir = `${tmpDir}/parts`;
  const manifestPath = `${tmpDir}/manifest.json`;
  const targetTmpPath = `${tmpDir}/assembled.tmp`;

  const fd = fs.openSync(localPath, 'r');
  try {
    await ensureRemoteDirectory(conn, 'content');
    await ensureRemoteDirectory(conn, TMP_ROOT);
    await ensureRemoteDirectory(conn, tmpDir);
    await ensureRemoteDirectory(conn, partsDir);
    await ensureRemoteParents(conn, remotePath);

    let uploadedCount = 0;
    await runPool(chunks, maxConcurrency, async (chunk) => {
      const base64 = readChunkAsBase64(fd, chunk.offset, chunk.size);
      await uploadBase64Blob(conn, `${partsDir}/${chunk.filename}`, base64, chunk.size, retries);
      uploadedCount++;
      onProgress?.({ type: 'chunk-progress', uploaded: uploadedCount, total: chunks.length });
    });

    onProgress?.({ type: 'uploading', message: 'Uploading manifest...' });
    const manifest = {
      transfer_id: transferId,
      target_final: `/${remotePath}`,
      target_tmp: `/${targetTmpPath}`,
      parts_dir: `/${partsDir}`,
      size_bytes: fileSize,
      chunk_size_bytes: chunkSizeBytes,
      chunk_count: chunks.length,
      part_names: chunks.map((c) => c.filename),
    };
    const manifestJson = JSON.stringify(manifest, null, 2);
    await uploadBase64Blob(
      conn,
      manifestPath,
      Buffer.from(manifestJson, 'utf8').toString('base64'),
      Buffer.byteLength(manifestJson, 'utf8'),
      retries,
    );

    onProgress?.({ type: 'assembling' });
    const output = await execOnKernel(buildAssembleCode(manifestPath));
    log.debug('Assemble output:', output);

    onProgress?.({ type: 'verifying' });
    await verifyUploadedFile(conn, remotePath, fileSize);

    onProgress?.({ type: 'done', remotePath, sizeBytes: fileSize });
    return { ok: true, strategy: 'chunked', localPath, remotePath, sizeBytes: fileSize };
  } finally {
    fs.closeSync(fd);
  }
}

// --- Main entry point ---

export async function uploadFile(
  conn: ConnectionProvider,
  options: UploadOptions,
  execOnKernel: (code: string) => Promise<string>,
  onProgress?: (event: UploadProgressEvent) => void,
): Promise<UploadResult> {
  const resolvedLocalPath = path.resolve(options.localPath);
  const stat = fs.statSync(resolvedLocalPath);
  if (!stat.isFile()) throw new Error(`Not a file: ${resolvedLocalPath}`);

  const remotePath = normalizeRemotePath(options.remotePath ?? '', path.basename(resolvedLocalPath));
  const strategy = chooseStrategy(stat.size);
  const retries = options.retries ?? DEFAULT_RETRIES;

  onProgress?.({ type: 'start', strategy, localPath: resolvedLocalPath, remotePath, sizeBytes: stat.size });

  if (strategy === 'drive') {
    throw new Error(
      `File size ${stat.size} bytes exceeds chunked limit of ${CHUNKED_MAX_BYTES} bytes (500 MiB). Google Drive upload is not yet implemented.`,
    );
  }

  if (strategy === 'direct') {
    return uploadDirect(conn, resolvedLocalPath, remotePath, stat.size, retries, onProgress);
  }

  return uploadChunked(
    conn, resolvedLocalPath, remotePath, stat.size, retries,
    options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES,
    Math.min(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY),
    execOnKernel, onProgress,
  );
}
