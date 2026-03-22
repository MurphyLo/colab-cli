import ora, { type Ora } from 'ora';

// ---------------------------------------------------------------------------
// Global JSON-mode state
// ---------------------------------------------------------------------------

let jsonMode = false;

export function setJsonMode(v: boolean): void {
  jsonMode = v;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

// ---------------------------------------------------------------------------
// jsonResult — write structured JSON to stdout
// ---------------------------------------------------------------------------

export function jsonResult(data: object): void {
  process.stdout.write(JSON.stringify(data) + '\n');
}

export function jsonError(message: string): void {
  process.stdout.write(JSON.stringify({ error: message }) + '\n');
}

// ---------------------------------------------------------------------------
// SilentSpinner — drop-in replacement for ora that swallows all output
// ---------------------------------------------------------------------------

interface SpinnerLike {
  start(text?: string): SpinnerLike;
  stop(): SpinnerLike;
  succeed(text?: string): SpinnerLike;
  fail(text?: string): SpinnerLike;
  info(text?: string): SpinnerLike;
  warn(text?: string): SpinnerLike;
  isSpinning: boolean;
  text: string;
}

class SilentSpinner implements SpinnerLike {
  isSpinning = false;
  text = '';

  start(text?: string): this {
    if (text) this.text = text;
    this.isSpinning = true;
    return this;
  }

  stop(): this {
    this.isSpinning = false;
    return this;
  }

  succeed(_text?: string): this {
    this.isSpinning = false;
    return this;
  }

  fail(_text?: string): this {
    this.isSpinning = false;
    return this;
  }

  info(_text?: string): this {
    this.isSpinning = false;
    return this;
  }

  warn(_text?: string): this {
    this.isSpinning = false;
    return this;
  }
}

// ---------------------------------------------------------------------------
// notifyAuthUrl — display OAuth URL on stderr (safe for JSON mode)
// ---------------------------------------------------------------------------

export function notifyAuthUrl(context: string, url: string): void {
  if (jsonMode) {
    jsonResult({ event: 'auth_required', context, url });
  } else {
    console.error(`Opening browser for ${context}...`);
    console.error(`\nIf the browser did not open, visit this URL to continue:\n${url}\n`);
  }
}

// ---------------------------------------------------------------------------
// createSpinner — returns real ora or silent no-op based on JSON mode
// ---------------------------------------------------------------------------

export function createSpinner(text: string): Ora {
  if (jsonMode) {
    return new SilentSpinner() as unknown as Ora;
  }
  return ora(text);
}
