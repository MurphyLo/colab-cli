import crypto from 'crypto';
import {
  getContentsMetadata,
  putDirectory,
} from '../jupyter/contents-client.js';

// --- Constants ---

export const DIRECT_LIMIT_BYTES = 20 * 1024 * 1024;
export const CHUNKED_MAX_BYTES = 500 * 1024 * 1024;
export const DEFAULT_CHUNK_SIZE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_CONCURRENCY = 25;
export const DEFAULT_RETRIES = 3;
export const TMP_ROOT = 'content/.colab-transfer-tmp';

// --- Interfaces ---

export interface ConnectionProvider {
  getProxyUrl(): string;
  getToken(): string;
}

export interface ChunkPlan {
  index: number;
  offset: number;
  size: number;
  filename: string;
}

export type TransferStrategy = 'direct' | 'chunked' | 'drive';

// --- Shared helpers ---

export function chooseStrategy(fileSize: number): TransferStrategy {
  if (fileSize <= DIRECT_LIMIT_BYTES) return 'direct';
  if (fileSize <= CHUNKED_MAX_BYTES) return 'chunked';
  return 'drive';
}

export function normalizeRemotePath(remotePath: string, fallbackBasename?: string): string {
  let value = String(remotePath || fallbackBasename || '').trim();
  if (!value) throw new Error('Remote path cannot be empty');
  value = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!value) throw new Error('Remote path cannot be empty');
  if (!value.startsWith('content/')) value = `content/${value}`;
  return value;
}

export function buildChunkPlan(fileSize: number, chunkSizeBytes: number): ChunkPlan[] {
  const chunks: ChunkPlan[] = [];
  let offset = 0;
  let index = 0;
  while (offset < fileSize) {
    const size = Math.min(chunkSizeBytes, fileSize - offset);
    chunks.push({
      index,
      offset,
      size,
      filename: `part-${String(index).padStart(6, '0')}`,
    });
    offset += size;
    index++;
  }
  return chunks;
}

export function createTransferId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        results[idx] = await worker(items[idx], idx);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function ensureRemoteDirectory(
  conn: ConnectionProvider,
  dirPath: string,
): Promise<void> {
  if (!dirPath || dirPath === 'content') return;
  try {
    const metadata = await getContentsMetadata(
      conn.getProxyUrl(),
      conn.getToken(),
      dirPath,
    );
    if (metadata && metadata.type === 'directory') return;
    throw new Error(`Remote path exists but is not a directory: ${dirPath}`);
  } catch (err: any) {
    if (err?.status !== 404) throw err;
  }
  await putDirectory(conn.getProxyUrl(), conn.getToken(), dirPath);
}

export async function ensureRemoteParents(
  conn: ConnectionProvider,
  remotePath: string,
): Promise<void> {
  const parts = remotePath.split('/');
  parts.pop();
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    await ensureRemoteDirectory(conn, current);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}
