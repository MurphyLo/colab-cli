import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { request as gaxiosRequest } from 'gaxios';
import { DRIVE_UPLOADS_DIR } from '../config.js';
import { findFileByName } from './client.js';
import { log } from '../logging/index.js';

const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB (multiple of 256 KiB)
const SIMPLE_LIMIT = 5 * 1024 * 1024; // 5 MiB — use simple upload below this
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 1000; // exponential backoff: 1s, 2s, 4s, 8s, 16s

const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files';

// --- Session state ---

interface UploadSessionState {
  sessionUri: string;
  localPath: string;
  fileName: string;
  totalBytes: number;
  bytesUploaded: number;
  parentId: string;
  createdAt: string;
}

export type DriveUploadProgressEvent =
  | { type: 'start'; fileName: string; totalBytes: number; resuming: boolean }
  | { type: 'progress'; bytesUploaded: number; totalBytes: number }
  | { type: 'skipped'; fileId: string; fileName: string; reason: string }
  | { type: 'done'; fileId: string; fileName: string; totalBytes: number };

// --- State persistence ---

function stateFilePath(localPath: string): string {
  const hash = crypto.createHash('sha256').update(path.resolve(localPath)).digest('hex').slice(0, 16);
  return path.join(DRIVE_UPLOADS_DIR, `${hash}.json`);
}

function loadState(localPath: string): UploadSessionState | undefined {
  const p = stateFilePath(localPath);
  if (!fs.existsSync(p)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return undefined;
  }
}

function saveState(state: UploadSessionState): void {
  fs.mkdirSync(DRIVE_UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(stateFilePath(state.localPath), JSON.stringify(state, null, 2));
}

function clearState(localPath: string): void {
  const p = stateFilePath(localPath);
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

// --- Resumable protocol ---

async function initSession(
  token: string,
  fileName: string,
  totalBytes: number,
  parentId: string,
  mimeType?: string,
): Promise<string> {
  const url = `${UPLOAD_BASE}?uploadType=resumable`;
  const res = await gaxiosRequest({
    url,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(totalBytes),
      ...(mimeType ? { 'X-Upload-Content-Type': mimeType } : {}),
    },
    body: JSON.stringify({
      name: fileName,
      parents: [parentId],
    }),
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Failed to initiate resumable upload (${res.status}): ${JSON.stringify(res.data)}`);
  }

  const sessionUri = res.headers['location'];
  if (!sessionUri) {
    throw new Error('No Location header in resumable upload initiation response');
  }
  return sessionUri;
}

async function queryStatus(
  sessionUri: string,
  totalBytes: number,
): Promise<number> {
  const res = await gaxiosRequest({
    url: sessionUri,
    method: 'PUT',
    headers: {
      'Content-Length': '0',
      'Content-Range': `bytes */${totalBytes}`,
    },
    validateStatus: () => true,
  });

  if (res.status === 200 || res.status === 201) {
    return totalBytes;
  }

  if (res.status === 308) {
    const range = res.headers['range'];
    if (range) {
      const match = range.match(/bytes=\d+-(\d+)/);
      if (match) return parseInt(match[1], 10) + 1;
    }
    return 0;
  }

  if (res.status === 404) {
    return -1;
  }

  throw new Error(`Unexpected status querying upload session (${res.status}): ${JSON.stringify(res.data)}`);
}

async function uploadChunk(
  sessionUri: string,
  chunk: Buffer,
  offset: number,
  totalBytes: number,
): Promise<{ complete: boolean; fileId?: string; bytesConfirmed: number }> {
  const end = offset + chunk.length - 1;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await gaxiosRequest({
        url: sessionUri,
        method: 'PUT',
        headers: {
          'Content-Length': String(chunk.length),
          'Content-Range': `bytes ${offset}-${end}/${totalBytes}`,
        },
        body: chunk,
        validateStatus: () => true,
      });
    } catch (err) {
      // Network error — retry
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt);
        log.debug(`Chunk upload network error, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        await sleep(delay);
        continue;
      }
      throw err;
    }

    if (res.status === 200 || res.status === 201) {
      const data = res.data as { id?: string };
      return { complete: true, fileId: data.id, bytesConfirmed: totalBytes };
    }

    if (res.status === 308) {
      const range = res.headers['range'];
      let confirmed = offset + chunk.length;
      if (range) {
        const match = range.match(/bytes=\d+-(\d+)/);
        if (match) confirmed = parseInt(match[1], 10) + 1;
      }
      return { complete: false, bytesConfirmed: confirmed };
    }

    // Retryable server errors (500, 502, 503, 504)
    if (res.status >= 500 && attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt);
      log.debug(`Chunk upload got ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await sleep(delay);
      continue;
    }

    throw new Error(`Upload chunk failed (${res.status}): ${JSON.stringify(res.data)}`);
  }

  throw new Error('Upload chunk failed after all retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeFileMd5(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// --- Simple upload (≤ 5MB) ---

async function simpleUpload(
  token: string,
  localPath: string,
  fileName: string,
  parentId: string,
): Promise<string> {
  const fileContent = fs.readFileSync(localPath);

  const boundary = `----colab-cli-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name: fileName, parents: [parentId] });

  const parts = [
    `--${boundary}\r\n`,
    'Content-Type: application/json; charset=UTF-8\r\n\r\n',
    metadata,
    `\r\n--${boundary}\r\n`,
    'Content-Type: application/octet-stream\r\n\r\n',
  ];
  const prefix = Buffer.from(parts.join(''));
  const suffix = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([prefix, fileContent, suffix]);

  const url = `${UPLOAD_BASE}?uploadType=multipart`;
  const res = await gaxiosRequest({
    url,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Simple upload failed (${res.status}): ${JSON.stringify(res.data)}`);
  }

  return (res.data as { id: string }).id;
}

// --- Main entry point ---

export async function resumableUpload(
  token: string,
  localPath: string,
  options?: {
    parentId?: string;
    onProgress?: (event: DriveUploadProgressEvent) => void;
  },
): Promise<{ fileId: string; fileName: string; totalBytes: number }> {
  const resolvedPath = path.resolve(localPath);
  const stat = fs.statSync(resolvedPath);
  const totalBytes = stat.size;
  const fileName = path.basename(resolvedPath);
  const parentId = options?.parentId || 'root';
  const onProgress = options?.onProgress;

  // Dedup: check if an identical file already exists in the target folder
  const remote = await findFileByName(token, fileName, parentId);
  if (remote?.md5Checksum) {
    const localMd5 = await computeFileMd5(resolvedPath);
    if (localMd5 === remote.md5Checksum) {
      onProgress?.({ type: 'skipped', fileId: remote.id, fileName, reason: 'identical file exists (MD5 match)' });
      return { fileId: remote.id, fileName, totalBytes };
    }
    log.debug(`MD5 mismatch: local=${localMd5}, remote=${remote.md5Checksum}, uploading new version`);
  }

  // Small file: simple upload
  if (totalBytes <= SIMPLE_LIMIT) {
    onProgress?.({ type: 'start', fileName, totalBytes, resuming: false });
    const fileId = await simpleUpload(token, resolvedPath, fileName, parentId);
    onProgress?.({ type: 'progress', bytesUploaded: totalBytes, totalBytes });
    onProgress?.({ type: 'done', fileId, fileName, totalBytes });
    return { fileId, fileName, totalBytes };
  }

  // Large file: resumable upload
  let sessionUri: string;
  let bytesUploaded = 0;
  let resuming = false;

  // Check for existing session
  const existing = loadState(resolvedPath);
  if (existing && existing.totalBytes === totalBytes && existing.parentId === parentId) {
    log.debug(`Found existing upload session for ${fileName}, querying status...`);
    const confirmed = await queryStatus(existing.sessionUri, totalBytes);
    if (confirmed === -1) {
      log.debug('Session expired, starting fresh');
      clearState(resolvedPath);
    } else if (confirmed >= totalBytes) {
      log.debug('Upload already complete');
      clearState(resolvedPath);
      onProgress?.({ type: 'start', fileName, totalBytes, resuming: true });
      onProgress?.({ type: 'done', fileId: 'unknown', fileName, totalBytes });
      return { fileId: 'unknown', fileName, totalBytes };
    } else {
      sessionUri = existing.sessionUri;
      bytesUploaded = confirmed;
      resuming = true;
      log.debug(`Resuming from byte ${bytesUploaded}`);
    }
  }

  if (!sessionUri!) {
    sessionUri = await initSession(token, fileName, totalBytes, parentId);
    bytesUploaded = 0;
  }

  onProgress?.({ type: 'start', fileName, totalBytes, resuming });

  // Save state for resumability
  saveState({
    sessionUri,
    localPath: resolvedPath,
    fileName,
    totalBytes,
    bytesUploaded,
    parentId,
    createdAt: new Date().toISOString(),
  });

  // Upload in chunks
  const fd = fs.openSync(resolvedPath, 'r');
  try {
    while (bytesUploaded < totalBytes) {
      const remaining = totalBytes - bytesUploaded;
      const chunkSize = Math.min(CHUNK_SIZE, remaining);
      const chunk = Buffer.alloc(chunkSize);
      fs.readSync(fd, chunk, 0, chunkSize, bytesUploaded);

      const result = await uploadChunk(sessionUri, chunk, bytesUploaded, totalBytes);
      bytesUploaded = result.bytesConfirmed;

      onProgress?.({ type: 'progress', bytesUploaded, totalBytes });

      // Update state
      saveState({
        sessionUri,
        localPath: resolvedPath,
        fileName,
        totalBytes,
        bytesUploaded,
        parentId,
        createdAt: new Date().toISOString(),
      });

      if (result.complete) {
        clearState(resolvedPath);
        onProgress?.({ type: 'done', fileId: result.fileId!, fileName, totalBytes });
        return { fileId: result.fileId!, fileName, totalBytes };
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  clearState(resolvedPath);
  throw new Error('Upload ended unexpectedly');
}
