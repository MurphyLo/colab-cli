import ora from 'ora';
import { AuthManager } from '../auth/auth-manager.js';

export async function loginCommand(authManager: AuthManager): Promise<void> {
  if (authManager.isLoggedIn()) {
    const account = authManager.getAccount();
    console.log(`Already logged in as ${account?.label} (${account?.id})`);
    return;
  }

  const spinner = ora('Opening browser for Google sign-in...').start();
  try {
    const user = await authManager.login();
    spinner.succeed(`Signed in as ${user.name} (${user.email})`);
  } catch (err) {
    spinner.fail('Sign-in failed');
    throw err;
  }
}

export async function statusCommand(authManager: AuthManager): Promise<void> {
  if (!authManager.isLoggedIn()) {
    console.log('Not logged in. Run `colab-cli auth login` to sign in.');
    return;
  }
  const account = authManager.getAccount();
  console.log(`Logged in as: ${account?.label} (${account?.id})`);
}

export async function logoutCommand(authManager: AuthManager): Promise<void> {
  if (!authManager.isLoggedIn()) {
    console.log('Not logged in.');
    return;
  }
  const account = authManager.getAccount();
  await authManager.logout();
  console.log(`Signed out from ${account?.label} (${account?.id})`);
}
