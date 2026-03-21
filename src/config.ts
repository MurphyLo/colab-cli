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

// Drive uses a separate OAuth client (rclone's public credentials)
// because the Colab extension's OAuth client doesn't have Drive API access.
export const DRIVE_CLIENT_ID = process.env.COLAB_DRIVE_CLIENT_ID ?? '202264815644.apps.googleusercontent.com';
export const DRIVE_CLIENT_SECRET = process.env.COLAB_DRIVE_CLIENT_SECRET ?? 'X4Z3ca8xfWDb1Voo-F9a7ZxJ';
export const DRIVE_SCOPES = [
  'email',
  'https://www.googleapis.com/auth/drive',
] as const;

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'colab-cli');
export const AUTH_FILE = path.join(CONFIG_DIR, 'auth.json');
export const DRIVE_AUTH_FILE = path.join(CONFIG_DIR, 'drive-auth.json');
export const SERVERS_FILE = path.join(CONFIG_DIR, 'servers.json');
export const DRIVE_UPLOADS_DIR = path.join(CONFIG_DIR, 'drive-uploads');
