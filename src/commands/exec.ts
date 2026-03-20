import fs from 'fs';
import ora from 'ora';
import { ColabClient } from '../colab/client.js';
import { handleEphemeralAuth } from '../auth/ephemeral.js';
import { DaemonClient } from '../daemon/client.js';
import { renderOutput, renderStream } from '../output/terminal-renderer.js';
import { RuntimeManager } from '../runtime/runtime-manager.js';
import type { KernelOutput } from '../jupyter/kernel-connection.js';

export async function execCommand(
  runtimeManager: RuntimeManager,
  colabClient: ColabClient,
  options: {
    code?: string;
    file?: string;
    endpoint?: string;
    batch?: boolean;
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

  const server = options.endpoint
    ? runtimeManager.getServerByEndpoint(options.endpoint)
    : runtimeManager.getLatestServer();
  if (!server) {
    console.error('No runtime found. Create one first with `colab-cli runtime create`.');
    process.exit(1);
  }

  const spinner = ora('Connecting to daemon...').start();
  const client = new DaemonClient();
  try {
    await client.connect(server.id);
    spinner.stop();
  } catch (err) {
    spinner.fail('Failed to connect to daemon');
    throw err;
  }

  try {
    const outputs = client.exec(code, {
      handleEphemeralAuth: async (authType) => {
        await handleEphemeralAuth(colabClient, server.endpoint, authType, server.label);
      },
    });
    if (options.batch) {
      const collected: KernelOutput[] = [];
      for await (const output of outputs) {
        collected.push(output);
      }
      for (const output of collected) {
        renderOutput(output);
      }
    } else {
      await renderStream(outputs);
    }
  } finally {
    client.close();
  }
}
