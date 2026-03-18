import readline from 'readline';
import open from 'open';
import { AuthType } from '../colab/api.js';
import { ColabClient } from '../colab/client.js';
import { log } from '../logging/index.js';

export async function handleEphemeralAuth(
  apiClient: ColabClient,
  endpoint: string,
  authType: AuthType,
): Promise<void> {
  const dryRunResult = await apiClient.propagateCredentials(endpoint, {
    authType,
    dryRun: true,
  });
  log.trace(`[${authType}] Credentials propagation dry run:`, dryRunResult);

  if (dryRunResult.success) {
    await propagateCredentials(apiClient, endpoint, authType);
  } else if (dryRunResult.unauthorizedRedirectUri) {
    const consent = await promptUserConsent(authType, dryRunResult.unauthorizedRedirectUri);
    if (!consent) {
      throw new Error(`User cancelled ${authType} authorization`);
    }
    await propagateCredentials(apiClient, endpoint, authType);
  } else {
    throw new Error(
      `[${authType}] Credentials propagation dry run returned unexpected results: ${JSON.stringify(dryRunResult)}`,
    );
  }
}

async function promptUserConsent(
  authType: AuthType,
  unauthorizedRedirectUri: string,
): Promise<boolean> {
  let message: string;
  switch (authType) {
    case AuthType.DFS_EPHEMERAL:
      message = 'The runtime is requesting access to your Google Drive files.';
      break;
    case AuthType.AUTH_USER_EPHEMERAL:
      message = 'The runtime is requesting access to your Google credentials.';
      break;
    default:
      throw new Error(`Unsupported auth type: ${String(authType)}`);
  }

  console.log(`\n${message}`);
  const answer = await askQuestion('Allow? (y/n): ');
  if (answer.toLowerCase() !== 'y') {
    return false;
  }

  await open(unauthorizedRedirectUri);
  console.log('Please complete authorization in your browser.');
  const done = await askQuestion('Press Enter when done...');
  return true;
}

async function propagateCredentials(
  apiClient: ColabClient,
  endpoint: string,
  authType: AuthType,
): Promise<void> {
  const result = await apiClient.propagateCredentials(endpoint, {
    authType,
    dryRun: false,
  });
  log.trace(`[${authType}] credentials propagation:`, result);
  if (!result.success) {
    throw new Error(`[${authType}] Credentials propagation unsuccessful`);
  }
}

function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
