import { KernelOutput } from '../jupyter/kernel-connection.js';

// MIME types whose `savedPaths` entries should be surfaced to the user.
// Kept here (rather than imported from image-saver) so the renderer has
// no daemon-side dependency.
const reportedImageMimes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/svg+xml',
]);

function printSavedPaths(savedPaths: Record<string, string> | undefined): void {
  if (!savedPaths) return;
  for (const [mime, filePath] of Object.entries(savedPaths)) {
    if (reportedImageMimes.has(mime)) {
      console.log(`[saved ${mime} → ${filePath}]`);
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
      printSavedPaths(output.savedPaths);
      break;
    }

    case 'display_data': {
      const text = output.data['text/plain'];
      if (text) {
        console.log(text);
      }
      printSavedPaths(output.savedPaths);
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
