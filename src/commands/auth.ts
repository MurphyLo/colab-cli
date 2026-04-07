import { AuthManager } from '../auth/auth-manager.js';
import { startBackgroundAuth } from '../auth/background-auth.js';
import { createSpinner, isJsonMode, jsonResult, notifyAuthUrl } from '../output/json-output.js';

export async function loginCommand(authManager: AuthManager): Promise<void> {
  if (authManager.isLoggedIn()) {
    const account = authManager.getAccount();
    if (isJsonMode()) {
      jsonResult({ command: 'auth.login', alreadyLoggedIn: true, name: account?.label, email: account?.id });
    } else {
      console.log(`Already logged in as ${account?.label} (${account?.id})`);
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
    spinner.succeed(`Signed in as ${user.name} (${user.email})`);
  } catch (err) {
    spinner.fail('Sign-in failed');
    throw err;
  }
}

export async function statusCommand(authManager: AuthManager): Promise<void> {
  if (!authManager.isLoggedIn()) {
    if (isJsonMode()) {
      jsonResult({ command: 'auth.status', loggedIn: false });
    } else {
      console.log('Not logged in. Run `colab auth login` to sign in.');
    }
    return;
  }
  const account = authManager.getAccount();
  if (isJsonMode()) {
    jsonResult({ command: 'auth.status', loggedIn: true, name: account?.label, email: account?.id });
  } else {
    console.log(`Logged in as: ${account?.label} (${account?.id})`);
  }
}

export async function logoutCommand(authManager: AuthManager): Promise<void> {
  if (!authManager.isLoggedIn()) {
    if (isJsonMode()) {
      jsonResult({ command: 'auth.logout', wasLoggedIn: false });
    } else {
      console.log('Not logged in.');
    }
    return;
  }
  const account = authManager.getAccount();
  await authManager.logout();
  if (isJsonMode()) {
    jsonResult({ command: 'auth.logout', wasLoggedIn: true, name: account?.label, email: account?.id });
  } else {
    console.log(`Signed out from ${account?.label} (${account?.id})`);
  }
}
