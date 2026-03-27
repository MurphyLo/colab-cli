import fs from 'fs';
import { ColabClient } from '../colab/client.js';
import { handleEphemeralAuth } from '../auth/ephemeral.js';
import { DaemonClient } from '../daemon/client.js';
import { renderOutput, renderStream, setOutputDir, saveImages } from '../output/terminal-renderer.js';
import { RuntimeManager } from '../runtime/runtime-manager.js';
import type { KernelOutput } from '../jupyter/kernel-connection.js';
import { createSpinner, isJsonMode, jsonResult } from '../output/json-output.js';

export async function execCommand(
  runtimeManager: RuntimeManager,
  colabClient: ColabClient,
  options: {
    code?: string;
    file?: string;
    endpoint?: string;
    batch?: boolean;
    outputDir?: string;
  },
): Promise<void> {
  let code: string;
  if (options.file) {
    code = fs.readFileSync(options.file, 'utf-8');
  } else if (options.code) {
    code = options.code;
  } else {
    console.error('Provide code as argument or use -f <file>');
    process.exit(1);
  }

  setOutputDir(options.outputDir);

  const server = options.endpoint
    ? runtimeManager.getServerByEndpoint(options.endpoint)
    : runtimeManager.getLatestServer();
  if (!server) {
    console.error('No runtime found. Create one first with `colab runtime create`.');
    process.exit(1);
  }

  const spinner = createSpinner('Connecting to daemon...').start();
  const client = new DaemonClient();
  try {
    await client.connect(server.id);
    spinner.stop();
  } catch (err) {
    spinner.fail('Failed to connect to daemon');
    throw err;
  }

  let hasError = false;
  try {
    const outputs = client.exec(code, {
      handleEphemeralAuth: async (authType) => {
        await handleEphemeralAuth(colabClient, server.endpoint, authType, server.label);
      },
    });
    if (isJsonMode()) {
      // JSON mode: batch-collect, save images (replaces base64 with file paths), then emit
      const collected: KernelOutput[] = [];
      for await (const output of outputs) {
        if (output.type === 'display_data' || output.type === 'execute_result') {
          saveImages(output.data);
        }
        collected.push(output);
        if (output.type === 'error') hasError = true;
      }
      jsonResult({ command: 'exec', outputs: collected, ...(hasError ? { error: true } : {}) });
    } else if (options.batch) {
      const collected: KernelOutput[] = [];
      for await (const output of outputs) {
        collected.push(output);
        if (output.type === 'error') hasError = true;
      }
      for (const output of collected) {
        renderOutput(output);
      }
    } else {
      hasError = await renderStream(outputs);
    }
  } finally {
    client.close();
  }

  if (hasError) {
    process.exitCode = 1;
  }
}
