/**
 * Bounded circular buffer for terminal output.
 *
 * Stores recent terminal output in memory for replay on attach.
 * When the buffer exceeds `maxBytes`, the oldest chunks are evicted.
 *
 * No disk persistence — in-memory replay is sufficient for the CLI's
 * attach/detach model and the bounded buffer size.
 */

const DEFAULT_MAX_BYTES = 100 * 1024; // 100 KB

/**
 * Strip ANSI escape sequences (SGR, cursor movement, erase, etc.)
 * from a string, returning only the visible text content.
 */
function stripAnsi(s: string): string {
  // Matches: CSI sequences including DEC private modes (ESC[?...X),
  // OSC sequences (ESC]...ST), and other ESC-initiated sequences
  return s.replace(/\x1b\[[\x20-\x3f]*[0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^[\]].?/g, '');
}

/**
 * Simulate terminal rendering for a single line that may contain `\r`
 * (carriage return). In a real terminal, `\r` moves the cursor to column 0,
 * so subsequent characters overwrite from the beginning. For snapshot output
 * we truncate the buffer to the length of the last segment, since trailing
 * remnants from a previous longer write are visual artifacts that a real
 * terminal would clear with ANSI erase-to-end-of-line in most programs.
 */
function resolveCarriageReturns(line: string): string {
  if (!line.includes('\r')) return line;

  const segments = line.split('\r');
  let result = '';

  for (const seg of segments) {
    if (seg.length === 0) continue;
    // Each \r resets to column 0; the new segment replaces from the start.
    // Truncate to new segment length to avoid trailing remnants.
    result = seg + result.slice(seg.length);
  }

  // Final trim: the last non-empty segment is the "truth"
  const lastNonEmpty = segments.filter(s => s.length > 0).pop();
  if (lastNonEmpty) {
    result = result.slice(0, lastNonEmpty.length);
  }

  return result;
}

/**
 * Process raw terminal output for snapshot consumption:
 * 1. Strip ANSI escape sequences
 * 2. Resolve \r (carriage return) overwrites within each line
 * 3. Collapse consecutive blank lines (artifacts of full-screen terminal
 *    rendering) into at most one
 * 4. Trim leading/trailing blank lines
 *
 * This makes `--tail` / `--no-wait` output look like what a human would
 * actually see on the terminal screen, instead of showing every intermediate
 * progress-bar update as a separate line.
 */
function renderForSnapshot(raw: string): string {
  const stripped = stripAnsi(raw);

  // Normalize line endings: split on \n, then resolve \r within each line.
  const lines = stripped.split('\n');
  const rendered: string[] = [];

  for (const line of lines) {
    rendered.push(resolveCarriageReturns(line));
  }

  // Collapse consecutive blank lines into at most one. Large runs of blanks
  // are artifacts of tmux full-screen rendering (empty terminal rows).
  const collapsed: string[] = [];
  let prevBlank = false;
  for (const line of rendered) {
    const isBlank = line.trim() === '';
    if (isBlank && prevBlank) continue;
    collapsed.push(line);
    prevBlank = isBlank;
  }

  // Trim leading/trailing blank lines — they are screen-area artifacts,
  // not meaningful output.
  while (collapsed.length > 0 && collapsed[0].trim() === '') collapsed.shift();
  while (collapsed.length > 0 && collapsed[collapsed.length - 1].trim() === '') collapsed.pop();

  return collapsed.join('\n');
}

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
   *
   * When `snapshot` is true (used by `--no-wait` / `--tail` modes),
   * the output is post-processed to simulate real terminal rendering:
   * ANSI escapes are stripped, and \r-based overwrites (progress bars,
   * git clone percentages, etc.) are collapsed so only the final
   * visible state of each line is returned.
   */
  getContents(tailBytes?: number, snapshot = false): string {
    const full = this.chunks.join('');

    let result: string;
    if (tailBytes === undefined || tailBytes <= 0) {
      result = full;
    } else {
      const buf = Buffer.from(full, 'utf8');
      if (tailBytes >= buf.length) {
        result = full;
      } else {
        result = buf.subarray(buf.length - tailBytes).toString('utf8');
      }
    }

    return snapshot ? renderForSnapshot(result) : result;
  }

  /** Clear all buffered content. */
  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}
