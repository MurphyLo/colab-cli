import { Terminal } from '@xterm/headless';

const DEFAULT_MAX_BYTES = 100 * 1024; // 100 KB
const MAX_SCROLLBACK_LINES = 1000;

export class TerminalBuffer {
  private chunks: string[] = [];
  private totalBytes = 0;
  private terminal: Terminal;

  constructor(
    private readonly maxBytes: number = DEFAULT_MAX_BYTES,
    cols: number = 80,
    rows: number = 24,
  ) {
    this.terminal = new Terminal({
      cols: Math.max(1, cols),
      rows: Math.max(1, rows),
      scrollback: MAX_SCROLLBACK_LINES,
      allowProposedApi: true,
      convertEol: true,
    });
  }

  append(data: string): void {
    const byteLen = Buffer.byteLength(data, 'utf8');
    this.chunks.push(data);
    this.totalBytes += byteLen;

    while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
      const evicted = this.chunks.shift()!;
      this.totalBytes -= Buffer.byteLength(evicted, 'utf8');
    }

    if (this.totalBytes > this.maxBytes && this.chunks.length === 1) {
      const buf = Buffer.from(this.chunks[0], 'utf8');
      const trimmed = buf.subarray(buf.length - this.maxBytes);
      this.chunks[0] = trimmed.toString('utf8');
      this.totalBytes = trimmed.length;
    }

    this.terminal.write(data);
  }

  getContents(tailBytes?: number): string {
    const full = this.chunks.join('');
    if (tailBytes === undefined || tailBytes <= 0) return full;
    const buf = Buffer.from(full, 'utf8');
    if (tailBytes >= buf.length) return full;
    return buf.subarray(buf.length - tailBytes).toString('utf8');
  }

  getSnapshot(_cols: number, _rows: number, tailLines?: number): string {
    const buf = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    if (tailLines === undefined || tailLines <= 0) return lines.join('\n');
    if (tailLines >= lines.length) return lines.join('\n');
    return lines.slice(lines.length - tailLines).join('\n');
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(Math.max(1, cols), Math.max(1, rows));
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
    this.terminal.reset();
  }

  dispose(): void {
    this.terminal.dispose();
  }
}
