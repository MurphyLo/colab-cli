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

// DriveFS OAuth client — reads from env vars only; feature disabled when unset.
// These credentials allow direct Drive mounting without the browser-based
// ephemeral auth flow that Colab normally requires for each new runtime.
export const DRIVEFS_CLIENT_ID = process.env.COLAB_DRIVEFS_CLIENT_ID;
export const DRIVEFS_CLIENT_SECRET = process.env.COLAB_DRIVEFS_CLIENT_SECRET;
// client_channel lets DriveFS open its push channel (signaler-pa). Without it
// DriveFS never learns of remote changes, so files added to Drive after the
// mount stay invisible in directories it has already listed.
export const DRIVEFS_SCOPES = [
  'email',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/client_channel',
] as const;

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'colab-cli');
export const PROFILES_DIR = path.join(CONFIG_DIR, 'profiles');

export const DEFAULT_PROFILE_NAME = 'default';
const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._+@-]*$/;

export function isProfileDirName(name: string): boolean {
  return PROFILE_NAME_PATTERN.test(name) && name !== DEFAULT_PROFILE_NAME;
}

/**
 * Normalize a COLAB_PROFILE value. Returns undefined for the default profile
 * (credentials directly under CONFIG_DIR). An empty value is an error rather
 * than the default: a mistyped `COLAB_PROFILE=$VAR` must not silently act on
 * the default account.
 */
export function parseProfile(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const name = raw.toLowerCase();
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid COLAB_PROFILE ${JSON.stringify(raw)}: use a name or email made of letters, digits and . _ + @ -`,
    );
  }
  return name === DEFAULT_PROFILE_NAME ? undefined : name;
}

function resolveActiveProfile(): string | undefined {
  try {
    return parseProfile(process.env.COLAB_PROFILE);
  } catch (err) {
    // Runs at import time, before commander has parsed --json.
    const message = (err as Error).message;
    if (process.argv.includes('--json')) {
      process.stdout.write(JSON.stringify({ error: message }) + '\n');
    } else {
      console.error(`Error: ${message}`);
    }
    process.exit(1);
  }
}

// Each process serves one profile, selected by COLAB_PROFILE and inherited by
// the daemons it spawns, so different accounts can run side by side. Only the
// Colab session and its runtime records are per-profile. Daemon sockets stay
// in CONFIG_DIR: they are keyed by server UUID, and a path under a long email
// directory would exceed the 104-byte Unix socket limit on macOS.
export const ACTIVE_PROFILE = resolveActiveProfile();
export const PROFILE_DIR = ACTIVE_PROFILE ? path.join(PROFILES_DIR, ACTIVE_PROFILE) : CONFIG_DIR;
export const PROFILE_LABEL = ACTIVE_PROFILE ? ` (profile: ${ACTIVE_PROFILE})` : '';
export const LOGIN_COMMAND = ACTIVE_PROFILE
  ? `COLAB_PROFILE=${ACTIVE_PROFILE} colab auth login`
  : 'colab auth login';
/** Set when the profile is named after an account, which login then enforces. */
export const PROFILE_EMAIL = ACTIVE_PROFILE?.includes('@') ? ACTIVE_PROFILE : undefined;
export const COLAB_AUTH_URL_OPTIONS = {
  prompt: 'select_account consent',
  ...(PROFILE_EMAIL ? { login_hint: PROFILE_EMAIL } : {}),
};

const DEFAULT_AUTH_TIMEOUT_SECONDS = 300;
// setTimeout overflows above 2^31-1 ms and would fire immediately.
const MAX_AUTH_TIMEOUT_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

/**
 * How long a login waits for the browser callback. Read on demand, not at
 * import time, so a bad value only fails login commands.
 */
export function getAuthTimeoutMs(raw = process.env.COLAB_AUTH_TIMEOUT_SECONDS): number {
  if (raw === undefined) return DEFAULT_AUTH_TIMEOUT_SECONDS * 1000;
  const seconds = /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
  if (!(seconds <= MAX_AUTH_TIMEOUT_SECONDS)) {
    throw new Error(
      `Invalid COLAB_AUTH_TIMEOUT_SECONDS ${JSON.stringify(raw)}: use a whole number of seconds from 1 to ${MAX_AUTH_TIMEOUT_SECONDS}`,
    );
  }
  return seconds * 1000;
}

export const AUTH_FILE = path.join(PROFILE_DIR, 'auth.json');
export const SERVERS_FILE = path.join(PROFILE_DIR, 'servers.json');
export const DRIVE_AUTH_FILE = path.join(CONFIG_DIR, 'drive-auth.json');
export const DRIVE_MOUNT_AUTH_FILE = path.join(CONFIG_DIR, 'drive-mount-auth.json');
export const DRIVE_UPLOADS_DIR = path.join(CONFIG_DIR, 'drive-uploads');
export const SHELL_COUNTER_FILE = path.join(CONFIG_DIR, 'next-shell-id');
