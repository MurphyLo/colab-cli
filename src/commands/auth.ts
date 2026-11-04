import { AuthManager } from '../auth/auth-manager.js';
import { startBackgroundAuth } from '../auth/background-auth.js';
import { listProfiles } from '../auth/storage.js';
import { ACTIVE_PROFILE, DEFAULT_PROFILE_NAME, LOGIN_COMMAND, PROFILE_LABEL } from '../config.js';
import { createSpinner, isJsonMode, jsonResult, notifyAuthUrl } from '../output/json-output.js';

const profile = ACTIVE_PROFILE ?? DEFAULT_PROFILE_NAME;

export async function loginCommand(authManager: AuthManager): Promise<void> {
  if (authManager.isLoggedIn()) {
    const account = authManager.getAccount();
    if (isJsonMode()) {
      jsonResult({ command: 'auth.login', alreadyLoggedIn: true, profile, name: account?.label, email: account?.id });
    } else {
      console.log(`Already logged in as ${account?.label} (${account?.id})${PROFILE_LABEL}`);
    }
    return;
  }

  if (isJsonMode()) {
    await startBackgroundAuth('colab');
    return;
  }

  const spinner = createSpinner('Waiting for Google sign-in...').start();
  try {
    const user = await authManager.login((url) => {
      spinner.stop();
      notifyAuthUrl('Google sign-in', url);
      spinner.start('Waiting for authentication...');
    });
    spinner.succeed(`Signed in as ${user.name} (${user.email})${PROFILE_LABEL}`);
  } catch (err) {
    spinner.fail('Sign-in failed');
    throw err;
  }
}

export async function statusCommand(authManager: AuthManager): Promise<void> {
  if (!authManager.isLoggedIn()) {
    if (isJsonMode()) {
      jsonResult({ command: 'auth.status', loggedIn: false, profile });
    } else {
      console.log(`Not logged in${PROFILE_LABEL}. Run \`${LOGIN_COMMAND}\` to sign in.`);
    }
    return;
  }
  const account = authManager.getAccount();
  if (isJsonMode()) {
    jsonResult({ command: 'auth.status', loggedIn: true, profile, name: account?.label, email: account?.id });
  } else {
    console.log(`Logged in as: ${account?.label} (${account?.id})${PROFILE_LABEL}`);
  }
}

export async function logoutCommand(authManager: AuthManager): Promise<void> {
  if (!authManager.isLoggedIn()) {
    if (isJsonMode()) {
      jsonResult({ command: 'auth.logout', wasLoggedIn: false, profile });
    } else {
      console.log(`Not logged in${PROFILE_LABEL}.`);
    }
    return;
  }
  const account = authManager.getAccount();
  await authManager.logout();
  if (isJsonMode()) {
    jsonResult({ command: 'auth.logout', wasLoggedIn: true, profile, name: account?.label, email: account?.id });
  } else {
    console.log(`Signed out from ${account?.label} (${account?.id})${PROFILE_LABEL}`);
  }
}

export function listProfilesCommand(): void {
  const profiles = listProfiles();
  if (isJsonMode()) {
    jsonResult({
      command: 'auth.list',
      profiles: profiles.map((p) => ({ name: p.name, email: p.email ?? null, active: p.active })),
    });
    return;
  }
  const width = Math.max(...profiles.map((p) => p.name.length));
  for (const p of profiles) {
    console.log(`${p.active ? '*' : ' '} ${p.name.padEnd(width)}  ${p.email ?? '(not logged in)'}`);
  }
}
