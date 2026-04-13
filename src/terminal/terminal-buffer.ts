/**
 * Bounded circular buffer for terminal output.
 *
 * Stores recent terminal output in memory for replay on attach.
 * When the buffer exceeds `maxBytes`, the oldest chunks are evicted.
 *
 * No disk persistence — the `/colab/tty` endpoint is ephemeral
 * (no session reconnect), so disk recovery adds no value.
 */

const DEFAULT_MAX_BYTES = 100 * 1024; // 100 KB

export class TerminalBuffer {
  private chunks: string[] = [];
  private totalBytes = 0;

  constructor(private readonly maxBytes: number = DEFAULT_MAX_BYTES) {}

  /** Append a chunk of terminal output. Evicts oldest data if over limit. */
  append(data: string): void {
    const byteLen = Buffer.byteLength(data, 'utf8');
    this.chunks.push(data);
    this.totalBytes += byteLen;

    // Evict oldest chunks until within budget
    while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
      const evicted = this.chunks.shift()!;
      this.totalBytes -= Buffer.byteLength(evicted, 'utf8');
    }

    // If a single chunk exceeds maxBytes, truncate it from the front
    if (this.totalBytes > this.maxBytes && this.chunks.length === 1) {
      const buf = Buffer.from(this.chunks[0], 'utf8');
      const trimmed = buf.subarray(buf.length - this.maxBytes);
      this.chunks[0] = trimmed.toString('utf8');
      this.totalBytes = trimmed.length;
    }
  }

  /**
   * Returns buffered content as a single string.
   * If `tailBytes` is provided, returns only the last N bytes.
   */
  getContents(tailBytes?: number): string {
    const full = this.chunks.join('');
    if (tailBytes === undefined || tailBytes <= 0) {
      return full;
    }
    const buf = Buffer.from(full, 'utf8');
    if (tailBytes >= buf.length) {
      return full;
    }
    return buf.subarray(buf.length - tailBytes).toString('utf8');
  }

  /** Clear all buffered content. */
  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}
