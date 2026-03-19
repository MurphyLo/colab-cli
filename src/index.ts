#!/usr/bin/env node

// Warn if proxy env vars are set but --use-env-proxy is not enabled (Node.js 22+)
if (
  (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy) &&
  !process.execArgv.includes('--use-env-proxy')
) {
  console.warn(
    '[warn] Proxy environment variable detected but --use-env-proxy is not enabled.\n' +
    '       Run with: node --use-env-proxy dist/index.js\n' +
    '       Or use:   npm start (which includes this flag automatically)\n',
  );
}

import { Command } from 'commander';
import { COLAB_API_DOMAIN, COLAB_GAPI_DOMAIN, OAUTH_CLIENT_ID } from './config.js';
import { AuthManager } from './auth/auth-manager.js';
import { ColabClient } from './colab/client.js';
import { RuntimeManager } from './runtime/runtime-manager.js';
import { log } from './logging/index.js';
import { loginCommand, statusCommand, logoutCommand } from './commands/auth.js';
import {
  createRuntimeCommand,
  listAvailableRuntimesCommand,
  listRuntimesCommand,
  destroyRuntimeCommand,
  restartRuntimeCommand,
} from './commands/runtime.js';
import { execCommand } from './commands/exec.js';
import { usageCommand } from './commands/usage.js';

const program = new Command();

program
  .name('colab-cli')
  .description('Interact with Google Colab GPU runtimes from the terminal')
  .version('0.1.0')
  .option('--verbose', 'Enable verbose logging')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.verbose) {
      log.setVerbose(true);
    }
  });

// Shared state
let authManager: AuthManager;
let colabClient: ColabClient;
let runtimeManager: RuntimeManager;

async function ensureInitialized(): Promise<void> {
  if (authManager) return;

  if (!OAUTH_CLIENT_ID) {
    console.error(
      'OAuth client ID not configured. Set COLAB_CLIENT_ID and COLAB_CLIENT_SECRET environment variables.',
    );
    process.exit(1);
  }

  authManager = new AuthManager();
  await authManager.initialize();

  colabClient = new ColabClient(
    new URL(COLAB_API_DOMAIN),
    new URL(COLAB_GAPI_DOMAIN),
    () => authManager.getAccessToken(),
    () => authManager.logout(),
  );

  runtimeManager = new RuntimeManager(colabClient);
}

async function ensureLoggedIn(): Promise<void> {
  await ensureInitialized();
  if (!authManager.isLoggedIn()) {
    console.error('Not logged in. Run `colab-cli auth login` first.');
    process.exit(1);
  }
}

// Auth commands
const auth = program.command('auth').description('Authentication management');

auth
  .command('login')
  .description('Sign in with Google OAuth')
  .action(async () => {
    await ensureInitialized();
    await loginCommand(authManager);
  });

auth
  .command('status')
  .description('Show current authentication status')
  .action(async () => {
    await ensureInitialized();
    await statusCommand(authManager);
  });

auth
  .command('logout')
  .description('Sign out and revoke tokens')
  .action(async () => {
    await ensureInitialized();
    await logoutCommand(authManager);
  });

// Runtime commands
const runtime = program.command('runtime').description('Runtime management');

runtime
  .command('create')
  .description('Create a new Colab runtime')
  .requiredOption(
    '-a, --accelerator <accelerator>',
    'Accelerator in Colab UI semantics: CPU, H100, G4, A100, L4, T4, v6e-1, or v5e-1',
  )
  .option(
    '-s, --shape <shape>',
    'Machine shape in Colab UI semantics: standard, highmem, or high-ram',
  )
  .action(async (opts) => {
    await ensureLoggedIn();
    await createRuntimeCommand(runtimeManager, opts);
  });

runtime
  .command('available')
  .description('List available runtime variants and accelerator models')
  .action(async () => {
    await ensureLoggedIn();
    await listAvailableRuntimesCommand(colabClient);
  });

runtime
  .command('list')
  .description('List active runtimes')
  .action(async () => {
    await ensureLoggedIn();
    await listRuntimesCommand(runtimeManager);
  });

runtime
  .command('destroy')
  .description('Destroy a runtime')
  .option('-e, --endpoint <endpoint>', 'Runtime endpoint to destroy')
  .action(async (opts) => {
    await ensureLoggedIn();
    await destroyRuntimeCommand(runtimeManager, opts.endpoint);
  });

runtime
  .command('restart')
  .description('Restart the kernel (Python process, keeps VM alive)')
  .option('-e, --endpoint <endpoint>', 'Runtime endpoint')
  .action(async (opts) => {
    await ensureLoggedIn();
    await restartRuntimeCommand(runtimeManager, opts.endpoint);
  });

// Usage command
program
  .command('usage')
  .description('Show Colab subscription tier and compute unit usage')
  .action(async () => {
    await ensureLoggedIn();
    await usageCommand(colabClient);
  });

// Exec command
program
  .command('exec [code]')
  .description('Execute code on the runtime and stream output')
  .option('-f, --file <path>', 'Execute code from a file')
  .option('-e, --endpoint <endpoint>', 'Runtime endpoint')
  .option('-b, --batch', 'Collect all output and print at once instead of streaming')
  .action(async (code, opts) => {
    await ensureLoggedIn();
    await execCommand(runtimeManager, {
      code,
      file: opts.file,
      endpoint: opts.endpoint,
      batch: opts.batch,
    });
  });

// Graceful shutdown (daemons are independent processes and keep running)
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// Run
program.parseAsync().catch((err) => {
  if (err instanceof Error) {
    console.error(`Error: ${err.message}`);
    log.debug(err.stack);
  }
  process.exit(1);
});
