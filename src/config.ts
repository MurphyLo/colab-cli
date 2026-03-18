import os from 'os';
import path from 'path';

export const COLAB_API_DOMAIN = 'https://colab.research.google.com';
export const COLAB_GAPI_DOMAIN = 'https://colab.pa.googleapis.com';

// OAuth2 credentials extracted from VS Code Colab extension
export const OAUTH_CLIENT_ID = process.env.COLAB_CLIENT_ID ?? '1014160490159-cvot3bea7tgkp72a4m29h20d9ddo6bne.apps.googleusercontent.com';
export const OAUTH_CLIENT_SECRET = process.env.COLAB_CLIENT_SECRET ?? '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';

export const REQUIRED_SCOPES = [
  'profile',
  'email',
  'https://www.googleapis.com/auth/colaboratory',
] as const;

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'colab-cli');
export const AUTH_FILE = path.join(CONFIG_DIR, 'auth.json');
export const SERVERS_FILE = path.join(CONFIG_DIR, 'servers.json');
