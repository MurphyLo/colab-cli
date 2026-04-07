import fs from 'fs';
import path from 'path';
import type { KernelOutput } from '../jupyter/kernel-connection.js';

// Reused from vscode-jupyter plotSaveHandler.ts — canonical MIME→extension mapping.
const imageExtensionForMimeType: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

/**
 * Eagerly persist any image MIME types from a kernel output to `outputDir`.
 *
 * Returns a new output with `savedPaths` populated. The original base64
 * content in `data` is preserved unchanged so NDJSON keeps a stable backup
 * copy that can survive deletion of the on-disk image files.
 *
 * Filenames follow `exec<execId>-output-<counter>.<ext>` for cross-exec
 * isolation when multiple executions share the same output directory.
 *
 * If the output carries no images, returns the input untouched.
 * I/O failures are logged but do not abort execution — the base64 in
 * NDJSON remains as a fallback.
 */
export function saveOutputImages(
  output: KernelOutput,
  execId: number,
  outputDir: string,
  startCounter: number,
): { output: KernelOutput; nextCounter: number } {
  if (output.type !== 'display_data' && output.type !== 'execute_result') {
    return { output, nextCounter: startCounter };
  }

  const savedPaths: Record<string, string> = {};
  let counter = startCounter;
  let didSave = false;
  let dirReady = false;

  for (const [mime, content] of Object.entries(output.data)) {
    const ext = imageExtensionForMimeType[mime];
    if (!ext || !content) continue;

    counter++;
    const filePath = path.join(outputDir, `exec${execId}-output-${counter}.${ext}`);
    try {
      if (!dirReady) {
        fs.mkdirSync(outputDir, { recursive: true });
        dirReady = true;
      }
      if (mime === 'image/svg+xml') {
        // SVG is text, not base64-encoded
        fs.writeFileSync(filePath, content, 'utf-8');
      } else {
        // Binary image formats are base64-encoded in Jupyter wire protocol
        fs.writeFileSync(filePath, Buffer.from(content, 'base64'));
      }
      savedPaths[mime] = filePath;
      didSave = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[image-saver] failed to save ${mime} for exec ${execId} to ${filePath}: ${message}`,
      );
      // Roll back this slot so numbering stays dense.
      counter--;
    }
  }

  if (!didSave) {
    return { output, nextCounter: startCounter };
  }

  return {
    output: { ...output, savedPaths },
    nextCounter: counter,
  };
}
