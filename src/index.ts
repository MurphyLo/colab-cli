#!/usr/bin/env -S node --use-env-proxy --disable-warning=UNDICI-EHPA

import { Command } from 'commander';
import { COLAB_API_DOMAIN, COLAB_GAPI_DOMAIN, OAUTH_CLIENT_ID, DRIVEFS_CLIENT_ID } from './config.js';
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
  listRuntimeVersionsCommand,
  destroyRuntimeCommand,
  restartRuntimeCommand,
} from './commands/runtime.js';
import { execCommand } from './commands/exec.js';
import { fsUploadCommand, fsDownloadCommand } from './commands/fs.js';
import { usageCommand } from './commands/usage.js';
import {
  driveLoginCommand,
  driveLogoutCommand,
  driveStatusCommand,
  driveListCommand,
  driveUploadCommand,
  driveDownloadCommand,
  driveMkdirCommand,
  driveDeleteCommand,
  driveMoveCommand,
} from './commands/drive.js';
import { DriveAuthManager } from './drive/auth.js';
import { MountAuthManager } from './drive/mount-auth.js';
import {
  driveMountLoginCommand,
  driveMountLogoutCommand,
  driveMountCommand,
  driveMountStatusCommand,
} from './commands/drive-mount.js';

const program = new Command();

program
  .name('colab')
  .description('interact with Google Colab GPU runtimes from the terminal')
  .version('0.1.0')
  .option('--verbose', 'enable verbose logging')
  .option('--json', 'output results as JSON to stdout (for scripting)')
  .configureHelp({
    subcommandTerm: (cmd) => {
      const args = (cmd as any).registeredArguments
        .map((arg: any) => arg.required ? `<${arg._name}>` : `[${arg._name}]`)
        .join(' ');
      return cmd.name() + (args ? ' ' + args : '');
    },
  })
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
    if (isJsonMode()) {
      jsonError('Not logged in. Run `colab auth login` first.');
    } else {
      console.error('Not logged in. Run `colab auth login` first.');
    }
    process.exit(1);
  }
}

// Auth commands
const auth = program.command('auth').description('manage authentication');

auth
  .command('login')
  .description('sign in with Google OAuth')
  .action(async () => {
    await ensureInitialized();
    await loginCommand(authManager);
  });

auth
  .command('status')
  .description('show authentication status')
  .action(async () => {
    await ensureInitialized();
    await statusCommand(authManager);
  });

auth
  .command('logout')
  .description('sign out and revoke tokens')
  .action(async () => {
    await ensureInitialized();
    await logoutCommand(authManager);
  });

// Runtime commands
const runtime = program.command('runtime').description('manage runtimes');

runtime
  .command('create')
  .description('create a new runtime')
  .requiredOption(
    '-a, --accelerator <accelerator>',
    'accelerator in Colab UI semantics: CPU, H100, G4, A100, L4, T4, v6e-1, or v5e-1',
  )
  .option(
    '-s, --shape <shape>',
    'machine shape: standard or high-ram',
  )
  .option(
    '-v, --runtime-version <version>',
    'runtime version label (e.g. 2026.01). See `colab runtime versions`.',
  )
  .action(async (opts) => {
    await ensureLoggedIn();
    await createRuntimeCommand(runtimeManager, opts);
  });

runtime
  .command('available')
  .description('list available accelerators and machine shapes')
  .action(async () => {
    await ensureLoggedIn();
    await listAvailableRuntimesCommand(colabClient);
  });

runtime
  .command('versions')
  .description('list available runtime versions and their environment details')
  .action(async () => {
    await ensureLoggedIn();
    await listRuntimeVersionsCommand(colabClient);
  });

runtime
  .command('list')
  .description('list active runtimes')
  .action(async () => {
    await ensureLoggedIn();
    await listRuntimesCommand(runtimeManager);
  });

runtime
  .command('destroy')
  .description('destroy a runtime')
  .option('-e, --endpoint <endpoint>', 'runtime endpoint')
  .action(async (opts) => {
    await ensureLoggedIn();
    await destroyRuntimeCommand(runtimeManager, opts.endpoint);
  });

runtime
  .command('restart')
  .description('restart the kernel without destroying the VM')
  .option('-e, --endpoint <endpoint>', 'runtime endpoint')
  .action(async (opts) => {
    await ensureLoggedIn();
    await restartRuntimeCommand(runtimeManager, opts.endpoint);
  });

// Usage command
program
  .command('usage')
  .description('show subscription tier and compute-unit usage')
  .action(async () => {
    await ensureLoggedIn();
    await usageCommand(colabClient);
  });

// Exec command
program
  .command('exec [code]')
  .description('execute code on a runtime')
  .option('-f, --file <path>', 'execute code from a file')
  .option('-e, --endpoint <endpoint>', 'runtime endpoint')
  .option('-b, --batch', 'collect all output and print at once instead of streaming')
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
const fsCmd = program.command('fs').description('transfer files to and from a runtime');

fsCmd
  .command('upload <local-path>')
  .description('upload a file to the runtime')
  .option('-r, --remote-path <path>', 'remote destination path (default: content/<filename>)')
  .option('-e, --endpoint <endpoint>', 'runtime endpoint')
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
  .description('download a file from the runtime')
  .option('-o, --output <path>', 'local destination path (default: ./<filename>)')
  .option('-e, --endpoint <endpoint>', 'runtime endpoint')
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

function ensureDriveInit(): DriveAuthManager {
  if (!driveAuth) driveAuth = new DriveAuthManager();
  return driveAuth;
}

async function ensureDriveLoggedIn(): Promise<DriveAuthManager> {
  const da = ensureDriveInit();
  if (!da.isAuthorized()) {
    if (isJsonMode()) {
      jsonError('Drive not authorized. Run `colab drive login` first.');
    } else {
      console.error('Drive not authorized. Run `colab drive login` first.');
    }
    process.exit(1);
  }
  return da;
}

const drive = program.command('drive').description('manage files on Google Drive');

drive
  .command('login')
  .description('authorize Google Drive access')
  .action(async () => {
    await driveLoginCommand(ensureDriveInit());
  });

drive
  .command('logout')
  .description('remove stored Google Drive credentials')
  .action(async () => {
    await driveLogoutCommand(ensureDriveInit());
  });

drive
  .command('status')
  .description('show Google Drive authorization status')
  .action(async () => {
    await driveStatusCommand(ensureDriveInit());
  });

drive
  .command('list [folder-id]')
  .description('list files in a Google Drive folder')
  .action(async (folderId) => {
    const da = await ensureDriveLoggedIn();
    await driveListCommand(da, folderId);
  });

drive
  .command('upload <local-path>')
  .description('upload a file to Google Drive (best for large files)')
  .option('-p, --parent <folder-id>', 'parent folder ID (default: root)')
  .action(async (localPath, opts) => {
    const da = await ensureDriveLoggedIn();
    await driveUploadCommand(da, localPath, opts);
  });

drive
  .command('download <file-id>')
  .description('download a file from Google Drive')
  .option('-o, --output <path>', 'local output path')
  .action(async (fileId, opts) => {
    const da = await ensureDriveLoggedIn();
    await driveDownloadCommand(da, fileId, opts);
  });

drive
  .command('mkdir <name>')
  .description('create a folder on Google Drive')
  .option('-p, --parent <folder-id>', 'parent folder ID (default: root)')
  .action(async (name, opts) => {
    const da = await ensureDriveLoggedIn();
    await driveMkdirCommand(da, name, opts.parent);
  });

drive
  .command('delete <file-id>')
  .description('delete a file or folder on Google Drive')
  .option('--permanent', 'permanently delete instead of moving to trash')
  .action(async (fileId, opts) => {
    const da = await ensureDriveLoggedIn();
    await driveDeleteCommand(da, fileId, opts);
  });

drive
  .command('move <item-id>')
  .description('move a file or folder on Google Drive')
  .requiredOption('--to <folder-id>', 'destination folder ID')
  .action(async (itemId, opts) => {
    const da = await ensureDriveLoggedIn();
    await driveMoveCommand(da, itemId, opts.to);
  });

// Drive mount commands (requires COLAB_DRIVEFS_CLIENT_ID/SECRET env vars)
if (DRIVEFS_CLIENT_ID) {
  const driveMount = program
    .command('drive-mount')
    .description('mount Google Drive on a runtime without browser auth')
    .option('-e, --endpoint <endpoint>', 'runtime endpoint')
    .action(async (opts) => {
      await ensureLoggedIn();
      await driveMountCommand(runtimeManager, opts.endpoint);
    });

  driveMount
    .command('login')
    .description('authorize for automatic Google Drive mounting')
    .action(async () => {
      await driveMountLoginCommand();
    });

  driveMount
    .command('logout')
    .description('remove stored Google Drive mount credentials')
    .action(async () => {
      await driveMountLogoutCommand();
    });

  driveMount
    .command('status')
    .description('show Google Drive mount authorization status')
    .action(async () => {
      await driveMountStatusCommand();
    });
}

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
