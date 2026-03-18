import { KernelOutput } from '../jupyter/kernel-connection.js';

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
      break;
    }

    case 'display_data': {
      const text = output.data['text/plain'];
      if (text) {
        console.log(text);
      }
      // Note: image/png etc. could be saved to a file in the future
      if (output.data['image/png'] && !output.data['text/plain']) {
        console.log('[image/png output - use --output-dir to save]');
      }
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
): Promise<void> {
  for await (const output of outputs) {
    renderOutput(output);
  }
}
