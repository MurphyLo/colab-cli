#!/usr/bin/env -S node --use-env-proxy --disable-warning=UNDICI-EHPA

import { Command } from 'commander';
import { COLAB_API_DOMAIN, COLAB_GAPI_DOMAIN, OAUTH_CLIENT_ID } from './config.js';
import { AuthManager } from './auth/auth-manager.js';
import { ColabClient } from './colab/client.js';
import { RuntimeManager } from './runtime/runtime-manager.js';
import { log } from './logging/index.js';
import { setJsonMode, jsonError, jsonResult, isJsonMode } from './output/json-output.js';
import { AuthConsentError } from './auth/ephemeral.js';
import { loginCommand, statusCommand, logoutCommand } from './commands/auth.js';
import {
  createRuntimeCommand,
  listAvailableRuntimesCommand,
  listRuntimesCommand,
  destroyRuntimeCommand,
  restartRuntimeCommand,
} from './commands/runtime.js';
import { execCommand } from './commands/exec.js';
import { fsUploadCommand, fsDownloadCommand } from './commands/fs.js';
import { usageCommand } from './commands/usage.js';
import {
  driveListCommand,
  driveUploadCommand,
  driveDownloadCommand,
  driveMkdirCommand,
  driveDeleteCommand,
  driveMoveCommand,
} from './commands/drive.js';
import { DriveAuthManager } from './drive/auth.js';

const program = new Command();

program
  .name('colab-cli')
  .description('Interact with Google Colab GPU runtimes from the terminal')
  .version('0.1.0')
  .option('--verbose', 'Enable verbose logging')
  .option('--json', 'Output results as JSON to stdout (for scripting)')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.verbose) {
      log.setVerbose(true);
    }
    if (opts.json) {
      setJsonMode(true);
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
    'Machine shape: standard or high-ram',
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
    await execCommand(runtimeManager, colabClient, {
      code,
      file: opts.file,
      endpoint: opts.endpoint,
      batch: opts.batch,
    });
  });

// File system commands
const fsCmd = program.command('fs').description('Remote filesystem operations');

fsCmd
  .command('upload <local-path>')
  .description('Upload a file to the runtime')
  .option('-r, --remote-path <path>', 'Remote destination path (default: content/<filename>)')
  .option('-e, --endpoint <endpoint>', 'Runtime endpoint')
  .action(async (localPath, opts) => {
    await ensureLoggedIn();
    await fsUploadCommand(runtimeManager, {
      localPath,
      remotePath: opts.remotePath,
      endpoint: opts.endpoint,
    });
  });

fsCmd
  .command('download <remote-path>')
  .description('Download a file from the runtime')
  .option('-o, --output <path>', 'Local destination path (default: ./<filename>)')
  .option('-e, --endpoint <endpoint>', 'Runtime endpoint')
  .action(async (remotePath, opts) => {
    await ensureLoggedIn();
    await fsDownloadCommand(runtimeManager, {
      remotePath,
      localPath: opts.output,
      endpoint: opts.endpoint,
    });
  });

// Drive commands (uses separate OAuth credentials — no Colab login required)
let driveAuth: DriveAuthManager;

async function ensureDriveAuth(): Promise<DriveAuthManager> {
  if (!driveAuth) {
    driveAuth = new DriveAuthManager();
    await driveAuth.ensureAuthorized();
  }
  return driveAuth;
}

const drive = program.command('drive').description('Google Drive operations');

drive
  .command('list [folder-id]')
  .description('List files in a Drive folder (default: root)')
  .action(async (folderId) => {
    const da = await ensureDriveAuth();
    await driveListCommand(da, folderId);
  });

drive
  .command('upload <local-path>')
  .description('Upload a file to Google Drive (resumable for large files)')
  .option('-p, --parent <folder-id>', 'Parent folder ID (default: root)')
  .action(async (localPath, opts) => {
    const da = await ensureDriveAuth();
    await driveUploadCommand(da, localPath, opts);
  });

drive
  .command('download <file-id>')
  .description('Download a file from Google Drive')
  .option('-o, --output <path>', 'Local output path')
  .action(async (fileId, opts) => {
    const da = await ensureDriveAuth();
    await driveDownloadCommand(da, fileId, opts);
  });

drive
  .command('mkdir <name>')
  .description('Create a folder in Drive')
  .option('-p, --parent <folder-id>', 'Parent folder ID (default: root)')
  .action(async (name, opts) => {
    const da = await ensureDriveAuth();
    await driveMkdirCommand(da, name, opts.parent);
  });

drive
  .command('delete <file-id>')
  .description('Delete a file or folder from Drive')
  .option('--permanent', 'Permanently delete instead of moving to trash')
  .action(async (fileId, opts) => {
    const da = await ensureDriveAuth();
    await driveDeleteCommand(da, fileId, opts);
  });

drive
  .command('move <item-id>')
  .description('Move a file or folder to another Drive folder')
  .requiredOption('--to <folder-id>', 'Destination folder ID')
  .action(async (itemId, opts) => {
    const da = await ensureDriveAuth();
    await driveMoveCommand(da, itemId, opts.to);
  });

// Graceful shutdown (daemons are independent processes and keep running)
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// Run
program.parseAsync().catch((err) => {
  if (isJsonMode() && err instanceof AuthConsentError) {
    jsonResult({ error: 'consent_required', authType: err.authType, url: err.url });
  } else if (isJsonMode()) {
    jsonError(err instanceof Error ? err.message : String(err));
  } else {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
  log.debug(err instanceof Error ? err.stack : undefined);
  process.exit(1);
});
