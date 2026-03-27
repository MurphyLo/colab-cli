import fs from 'fs';
import path from 'path';
import { KernelOutput } from '../jupyter/kernel-connection.js';
import { CONFIG_DIR } from '../config.js';

// Reused from vscode-jupyter plotSaveHandler.ts — canonical MIME→extension mapping.
const imageExtensionForMimeType: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

const DEFAULT_OUTPUT_BASE = path.join(CONFIG_DIR, 'outputs');

let outputDir: string = DEFAULT_OUTPUT_BASE;
let outputCounter = 0;

export function setOutputDir(dir: string | undefined): void {
  if (dir) {
    // Explicit --output-dir: use as-is, user controls the path
    outputDir = dir;
  } else {
    // Default: timestamped subdirectory so successive runs don't overwrite
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    outputDir = path.join(DEFAULT_OUTPUT_BASE, ts);
  }
  outputCounter = 0;
  fs.mkdirSync(outputDir, { recursive: true });
}

/**
 * Save any image MIME types found in a Jupyter data bundle.
 * Follows the same MIME-type keying convention used by jupyter-kernel-client's
 * output_hook (client.py) and vscode-jupyter's plotSaveHandler.
 *
 * Mutates `data` in place: replaces base64/raw content with the saved file path,
 * so both terminal and JSON modes can reference the file without embedding raw data.
 */
export function saveImages(data: Record<string, string>): void {
  for (const [mime, content] of Object.entries(data)) {
    const ext = imageExtensionForMimeType[mime];
    if (!ext || !content) continue;
    outputCounter++;
    const filePath = path.join(outputDir, `output-${outputCounter}.${ext}`);
    if (mime === 'image/svg+xml') {
      // SVG is text, not base64-encoded
      fs.writeFileSync(filePath, content, 'utf-8');
    } else {
      // Binary image formats are base64-encoded in Jupyter wire protocol
      fs.writeFileSync(filePath, Buffer.from(content, 'base64'));
    }
    data[mime] = filePath;
  }
}

function printSavedPaths(data: Record<string, string>): void {
  for (const [mime, value] of Object.entries(data)) {
    if (mime in imageExtensionForMimeType) {
      console.log(`[saved ${mime} → ${value}]`);
    }
  }
}

export function renderOutput(output: KernelOutput): void {
  switch (output.type) {
    case 'stream':
      if (output.name === 'stderr') {
        process.stderr.write(output.text);
      } else {
        process.stdout.write(output.text);
      }
      break;

    case 'execute_result': {
      const text = output.data['text/plain'];
      if (text) {
        console.log(text);
      }
      saveImages(output.data);
      printSavedPaths(output.data);
      break;
    }

    case 'display_data': {
      const text = output.data['text/plain'];
      if (text) {
        console.log(text);
      }
      saveImages(output.data);
      printSavedPaths(output.data);
      break;
    }

    case 'error':
      // Traceback lines often contain ANSI escape codes for color
      for (const line of output.traceback) {
        console.error(line);
      }
      break;

    case 'status':
      // Status changes are silent in terminal output
      break;
  }
}

export async function renderStream(
  outputs: AsyncGenerator<KernelOutput>,
): Promise<boolean> {
  let hasError = false;
  for await (const output of outputs) {
    renderOutput(output);
    if (output.type === 'error') hasError = true;
  }
  return hasError;
}
