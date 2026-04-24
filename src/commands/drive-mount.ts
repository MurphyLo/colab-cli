import { MountAuthManager } from '../drive/mount-auth.js';
import { mountDrive } from '../drive/mount.js';
import { DaemonClient } from '../daemon/client.js';
import { RuntimeManager } from '../runtime/runtime-manager.js';
import { startBackgroundAuth } from '../auth/background-auth.js';
import { createSpinner, isJsonMode, jsonError, jsonResult } from '../output/json-output.js';

export async function driveMountLoginCommand(): Promise<void> {
  const mountAuth = new MountAuthManager();

  if (isJsonMode()) {
    if (mountAuth.isAuthorized()) {
      jsonResult({ command: 'drive-mount.login', alreadyLoggedIn: true, email: mountAuth.getEmail() ?? null });
    } else {
      await startBackgroundAuth('drive-mount');
    }
    return;
  }

  await mountAuth.ensureAuthorized();
  const email = mountAuth.getEmail();
  console.log(`Drive mount authorized${email ? ` as ${email}` : ''}.`);
  console.log('Future runtimes can now mount Drive automatically with `colab drive-mount`.');
}

export async function driveMountCommand(
  runtimeManager: RuntimeManager,
  endpoint?: string,
): Promise<void> {
  const mountAuth = new MountAuthManager();
  if (!mountAuth.isAuthorized()) {
    if (isJsonMode()) {
      jsonError('Drive mount not authorized. Run `colab drive-mount login` first.');
    } else {
      console.error('Drive mount not authorized. Run `colab drive-mount login` first.');
    }
    process.exit(1);
  }

  const server = await runtimeManager.resolveTarget(endpoint);

  const spinner = createSpinner('Connecting to daemon...').start();
  const client = new DaemonClient();
  try {
    await client.connect(server.id);
    spinner.text = 'Mounting Google Drive...';
    await mountDrive(client, mountAuth);
    if (isJsonMode()) {
      spinner.stop();
      jsonResult({ command: 'drive-mount', endpoint: server.endpoint, mountPath: '/content/drive' });
    } else {
      spinner.succeed('Google Drive mounted at /content/drive');
    }
  } catch (err) {
    spinner.fail('Drive mount failed');
    throw err;
  } finally {
    client.close();
  }
}

export async function driveMountLogoutCommand(): Promise<void> {
  if (!MountAuthManager.isConfigured()) {
    if (isJsonMode()) {
      jsonResult({ command: 'drive-mount.logout', configured: false, wasLoggedIn: false });
    } else {
      console.log('Drive mount not configured.');
    }
    return;
  }

  const mountAuth = new MountAuthManager();
  if (!mountAuth.isAuthorized()) {
    if (isJsonMode()) {
      jsonResult({ command: 'drive-mount.logout', configured: true, wasLoggedIn: false });
    } else {
      console.log('Not authorized.');
    }
    return;
  }
  const email = mountAuth.getEmail();
  await mountAuth.logout();
  if (isJsonMode()) {
    jsonResult({ command: 'drive-mount.logout', configured: true, wasLoggedIn: true, email: email ?? null });
  } else {
    console.log(`Drive mount authorization removed${email ? ` (${email})` : ''}.`);
  }
}

export async function driveMountStatusCommand(): Promise<void> {
  if (!MountAuthManager.isConfigured()) {
    if (isJsonMode()) {
      jsonResult({ command: 'drive-mount.status', configured: false, authorized: false });
    } else {
      console.error('Drive mount not configured.');
      console.error('Set COLAB_DRIVEFS_CLIENT_ID and COLAB_DRIVEFS_CLIENT_SECRET environment variables.');
    }
    return;
  }

  const mountAuth = new MountAuthManager();
  const authorized = mountAuth.isAuthorized();
  const email = authorized ? mountAuth.getEmail() : undefined;
  if (isJsonMode()) {
    jsonResult({ command: 'drive-mount.status', configured: true, authorized, email: email ?? null });
  } else if (authorized) {
    console.log(`Drive mount authorized${email ? ` (${email})` : ''}.`);
    console.log('Run `colab drive-mount` to mount Drive on the active runtime.');
  } else {
    console.log('Drive mount not yet authorized.');
    console.log('Run `colab drive-mount login` to set up.');
  }
}
