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
const MAX_SCROLLBACK_LINES = 1000;

/**
 * Minimal VT-style screen emulator used for `--no-wait` / `--tail` snapshots.
 *
 * tmux forwards redraws to the attached client using ANSI cursor positioning
 * (CUP/CUU/CUD/CHA) rather than raw `\r`, so a naive "strip ANSI + resolve \r
 * per line" pipeline duplicates every progress frame. This class interprets
 * the control sequences tmux actually emits, maintains a virtual screen, and
 * collects lines that scroll off the top into a scrollback list — the end
 * result is the plain text a human would actually see on screen.
 *
 * Implemented subset (enough for tmux + common progress UIs like rich.progress
 * and tqdm):
 *   C0:   BS, HT, LF, CR, BEL
 *   CSI:  CUU/CUD/CUF/CUB/CNL/CPL/CHA/CUP/HVP, ED(J), EL(K), IL/DL,
 *         ICH/DCH, SU/SD, VPA(d), SCP/RCP (s/u), SGR(m — ignored)
 *   DEC:  `ESC [?...h/l` (ignored; alt screen not tracked)
 *   ESC:  7/8 save/restore cursor, D/E/M index/NEL/RI, c reset
 *   OSC:  consumed and ignored
 *
 * Not handled: scroll regions (DECSTBM), character sets, wide-character
 * column widths (CJK rendered as single-column), alternate screen buffer
 * (1049/47/1047). These are rare enough in snapshot-consumer output that
 * minor misalignment is acceptable.
 */
class VirtualScreen {
  private cols: number;
  private rows: number;
  private screen: string[][];
  private row = 0;
  private col = 0;
  private savedCursor?: { row: number; col: number };
  private scrollback: string[] = [];
  /** Carries a partial ESC sequence across write() boundaries. */
  private pending = '';

  constructor(cols: number, rows: number) {
    this.cols = Math.max(1, cols | 0);
    this.rows = Math.max(1, rows | 0);
    this.screen = this.blankScreen();
  }

  write(data: string): void {
    const input = this.pending + data;
    this.pending = '';
    let i = 0;
    while (i < input.length) {
      const ch = input[i];
      if (ch === '\x1b') {
        const parsed = this.parseEscape(input, i);
        if (parsed === null) {
          // Incomplete sequence — carry over to next write.
          this.pending = input.slice(i);
          return;
        }
        this.handleEscape(parsed.kind, parsed.params, parsed.final);
        i = parsed.end;
        continue;
      }
      if (ch === '\r') this.col = 0;
      // LF is treated as CR+LF (LNM-on): tmux actually forwards `\r\n` and
      // programs often emit bare `\n` expecting line-discipline ONLCR. Either
      // way, snapshot consumers want the next-line-start semantics.
      else if (ch === '\n') { this.lineFeed(); this.col = 0; }
      else if (ch === '\b') { if (this.col > 0) this.col--; }
      else if (ch === '\t') this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
      else if (ch.charCodeAt(0) >= 0x20) this.putChar(ch);
      // other C0 (BEL, etc.) ignored
      i++;
    }
  }

  resize(cols: number, rows: number): void {
    cols = Math.max(1, cols | 0);
    rows = Math.max(1, rows | 0);
    if (cols === this.cols && rows === this.rows) return;
    const old = this.screen;
    this.screen = this.blankScreen(cols, rows);
    const copyRows = Math.min(old.length, rows);
    for (let r = 0; r < copyRows; r++) {
      const copyCols = Math.min(old[r].length, cols);
      for (let c = 0; c < copyCols; c++) this.screen[r][c] = old[r][c];
    }
    this.cols = cols;
    this.rows = rows;
    this.row = Math.min(this.row, rows - 1);
    this.col = Math.min(this.col, cols - 1);
  }

  render(): string {
    const visible = this.screen.map((r) => r.join('').replace(/\s+$/, ''));
    const lines = [...this.scrollback, ...visible];
    // Trim trailing blanks from the bottom of the visible area.
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  // ── internals ──

  private blankScreen(cols = this.cols, rows = this.rows): string[][] {
    const s: string[][] = [];
    for (let r = 0; r < rows; r++) s.push(new Array(cols).fill(' '));
    return s;
  }

  private putChar(ch: string): void {
    if (this.col >= this.cols) {
      this.col = 0;
      this.lineFeed();
    }
    this.screen[this.row][this.col] = ch;
    this.col++;
  }

  private lineFeed(): void {
    if (this.row < this.rows - 1) {
      this.row++;
    } else {
      const top = this.screen.shift()!;
      this.pushScrollback(top.join('').replace(/\s+$/, ''));
      this.screen.push(new Array(this.cols).fill(' '));
    }
  }

  private pushScrollback(line: string): void {
    this.scrollback.push(line);
    if (this.scrollback.length > MAX_SCROLLBACK_LINES) {
      this.scrollback.splice(0, this.scrollback.length - MAX_SCROLLBACK_LINES);
    }
  }

  private parseEscape(
    s: string,
    start: number,
  ): { kind: string; params: string; final: string; end: number } | null {
    const next = s[start + 1];
    if (next === undefined) return null;

    if (next === '[') {
      // CSI: ESC [ <private?> <params 0x30-0x3f> <intermediate 0x20-0x2f> <final 0x40-0x7e>
      let j = start + 2;
      let prefix = '';
      if (j < s.length && /[<=>?]/.test(s[j])) { prefix = s[j]; j++; }
      while (j < s.length) {
        const c = s.charCodeAt(j);
        if (c >= 0x30 && c <= 0x3f) { j++; continue; }
        break;
      }
      const paramsEnd = j;
      while (j < s.length) {
        const c = s.charCodeAt(j);
        if (c >= 0x20 && c <= 0x2f) { j++; continue; }
        break;
      }
      if (j >= s.length) return null;
      const finalCode = s.charCodeAt(j);
      // If we see something outside the CSI final-byte range, bail out by
      // consuming just ESC+[ so we don't get stuck.
      if (finalCode < 0x40 || finalCode > 0x7e) {
        return { kind: 'CSI_BAD', params: '', final: '', end: start + 2 };
      }
      return {
        kind: 'CSI' + prefix,
        params: s.slice(start + 2 + prefix.length, paramsEnd),
        final: s[j],
        end: j + 1,
      };
    }

    if (next === ']') {
      // OSC: ESC ] ... (BEL | ESC \)
      let j = start + 2;
      while (j < s.length) {
        const ch = s[j];
        if (ch === '\x07') return { kind: 'OSC', params: '', final: '', end: j + 1 };
        if (ch === '\x1b') {
          if (j + 1 >= s.length) return null;
          if (s[j + 1] === '\\') return { kind: 'OSC', params: '', final: '', end: j + 2 };
        }
        j++;
      }
      return null;
    }

    // Single-char ESC (7/8/D/E/M/c/=/>) or 2-char (( ) # %  + one more).
    if ('()#%'.includes(next)) {
      if (start + 2 >= s.length) return null;
      return { kind: 'ESC2', params: next, final: s[start + 2], end: start + 3 };
    }
    return { kind: 'ESC', params: '', final: next, end: start + 2 };
  }

  private handleEscape(kind: string, params: string, final: string): void {
    if (kind === 'CSI') {
      const nums = params === '' ? [] : params.split(';').map((p) => parseInt(p, 10));
      const n1 = (idx: number, def = 1) => {
        const v = nums[idx];
        return v === undefined || isNaN(v) || v === 0 ? def : v;
      };
      const n0 = (idx: number, def = 0) => {
        const v = nums[idx];
        return v === undefined || isNaN(v) ? def : v;
      };
      switch (final) {
        case 'A': this.row = Math.max(0, this.row - n1(0)); break;
        case 'B': this.row = Math.min(this.rows - 1, this.row + n1(0)); break;
        case 'C': this.col = Math.min(this.cols - 1, this.col + n1(0)); break;
        case 'D': this.col = Math.max(0, this.col - n1(0)); break;
        case 'E': this.row = Math.min(this.rows - 1, this.row + n1(0)); this.col = 0; break;
        case 'F': this.row = Math.max(0, this.row - n1(0)); this.col = 0; break;
        case 'G': case '`': this.col = this.clampCol(n1(0, 1) - 1); break;
        case 'H': case 'f': {
          this.row = this.clampRow(n1(0, 1) - 1);
          this.col = this.clampCol(n1(1, 1) - 1);
          break;
        }
        case 'd': this.row = this.clampRow(n1(0, 1) - 1); break;
        case 'J': this.eraseDisplay(n0(0, 0)); break;
        case 'K': this.eraseLine(n0(0, 0)); break;
        case 'L': this.insertLines(n1(0)); break;
        case 'M': this.deleteLines(n1(0)); break;
        case 'P': this.deleteChars(n1(0)); break;
        case '@': this.insertChars(n1(0)); break;
        case 'X': this.eraseChars(n1(0)); break;
        case 'S': this.scrollUp(n1(0)); break;
        case 'T': this.scrollDown(n1(0)); break;
        case 's': this.savedCursor = { row: this.row, col: this.col }; break;
        case 'u':
          if (this.savedCursor) { this.row = this.savedCursor.row; this.col = this.savedCursor.col; }
          break;
        default: break; // m (SGR), r (DECSTBM), h/l without '?', etc.
      }
      return;
    }
    if (kind === 'ESC') {
      switch (final) {
        case '7': this.savedCursor = { row: this.row, col: this.col }; break;
        case '8':
          if (this.savedCursor) { this.row = this.savedCursor.row; this.col = this.savedCursor.col; }
          break;
        case 'D': this.lineFeed(); break;                 // IND
        case 'E': this.lineFeed(); this.col = 0; break;   // NEL
        case 'M':                                          // RI
          if (this.row > 0) this.row--;
          else this.scrollDown(1);
          break;
        case 'c':
          this.screen = this.blankScreen();
          this.row = 0; this.col = 0; this.savedCursor = undefined;
          break;
        default: break;
      }
    }
    // CSI?, CSI>, OSC, ESC2, CSI_BAD — ignored
  }

  private clampRow(r: number): number { return Math.max(0, Math.min(this.rows - 1, r)); }
  private clampCol(c: number): number { return Math.max(0, Math.min(this.cols - 1, c)); }

  private eraseDisplay(mode: number): void {
    if (mode === 0) {
      for (let c = this.col; c < this.cols; c++) this.screen[this.row][c] = ' ';
      for (let r = this.row + 1; r < this.rows; r++)
        for (let c = 0; c < this.cols; c++) this.screen[r][c] = ' ';
    } else if (mode === 1) {
      for (let r = 0; r < this.row; r++)
        for (let c = 0; c < this.cols; c++) this.screen[r][c] = ' ';
      for (let c = 0; c <= this.col && c < this.cols; c++) this.screen[this.row][c] = ' ';
    } else {
      // 2 = whole display; 3 = whole + scrollback
      for (let r = 0; r < this.rows; r++)
        for (let c = 0; c < this.cols; c++) this.screen[r][c] = ' ';
      if (mode === 3) this.scrollback = [];
    }
  }

  private eraseLine(mode: number): void {
    const line = this.screen[this.row];
    if (mode === 0) for (let c = this.col; c < this.cols; c++) line[c] = ' ';
    else if (mode === 1) for (let c = 0; c <= this.col && c < this.cols; c++) line[c] = ' ';
    else for (let c = 0; c < this.cols; c++) line[c] = ' ';
  }

  private eraseChars(n: number): void {
    const line = this.screen[this.row];
    for (let c = this.col; c < this.col + n && c < this.cols; c++) line[c] = ' ';
  }

  private insertLines(n: number): void {
    for (let i = 0; i < n; i++) {
      this.screen.splice(this.row, 0, new Array(this.cols).fill(' '));
      if (this.screen.length > this.rows) this.screen.pop();
    }
  }

  private deleteLines(n: number): void {
    for (let i = 0; i < n; i++) {
      if (this.row < this.screen.length) this.screen.splice(this.row, 1);
      this.screen.push(new Array(this.cols).fill(' '));
    }
  }

  private insertChars(n: number): void {
    const line = this.screen[this.row];
    for (let i = 0; i < n; i++) {
      line.splice(this.col, 0, ' ');
      if (line.length > this.cols) line.pop();
    }
  }

  private deleteChars(n: number): void {
    const line = this.screen[this.row];
    for (let i = 0; i < n && this.col < line.length; i++) {
      line.splice(this.col, 1);
      line.push(' ');
    }
  }

  private scrollUp(n: number): void {
    for (let i = 0; i < n; i++) {
      const top = this.screen.shift()!;
      this.pushScrollback(top.join('').replace(/\s+$/, ''));
      this.screen.push(new Array(this.cols).fill(' '));
    }
  }

  private scrollDown(n: number): void {
    for (let i = 0; i < n; i++) {
      this.screen.pop();
      this.screen.unshift(new Array(this.cols).fill(' '));
    }
  }
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
  }

  /**
   * Raw buffered content for streaming replay on attach. If `tailBytes` is
   * provided, returns only the last N bytes. ANSI escapes and `\r` are kept
   * intact — the attaching client's terminal is responsible for rendering.
   */
  getContents(tailBytes?: number): string {
    const full = this.chunks.join('');
    if (tailBytes === undefined || tailBytes <= 0) return full;
    const buf = Buffer.from(full, 'utf8');
    if (tailBytes >= buf.length) return full;
    return buf.subarray(buf.length - tailBytes).toString('utf8');
  }

  /**
   * Rendered snapshot for `--no-wait` / `--tail` consumers: feeds the whole
   * buffer through a virtual screen so cursor-positioning redraws (tmux
   * forwarding, rich.progress panels) collapse to the text a human would
   * actually see. `tailLines`, if given, returns only the last N rendered
   * lines.
   */
  getSnapshot(cols: number, rows: number, tailLines?: number): string {
    const screen = new VirtualScreen(cols, rows);
    screen.write(this.chunks.join(''));
    const rendered = screen.render();
    if (tailLines === undefined || tailLines <= 0) return rendered;
    const lines = rendered.split('\n');
    if (tailLines >= lines.length) return rendered;
    return lines.slice(lines.length - tailLines).join('\n');
  }

  /** Clear all buffered content. */
  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}
