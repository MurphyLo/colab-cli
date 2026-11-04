import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import {
  ACTIVE_PROFILE,
  AUTH_FILE,
  CONFIG_DIR,
  DEFAULT_PROFILE_NAME,
  isProfileDirName,
  PROFILE_DIR,
  PROFILE_EMAIL,
  PROFILES_DIR,
} from '../config.js';

const RefreshableSessionSchema = z.object({
  id: z.string(),
  refreshToken: z.string(),
  account: z.object({
    id: z.string(),
    label: z.string(),
  }),
  scopes: z.array(z.string()),
});

export type RefreshableSession = z.infer<typeof RefreshableSessionSchema>;

function ensureProfileDir() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
}

function readSession(file: string): RefreshableSession | undefined {
  try {
    if (!fs.existsSync(file)) {
      return undefined;
    }
    const data = fs.readFileSync(file, 'utf-8');
    return RefreshableSessionSchema.parse(JSON.parse(data));
  } catch {
    return undefined;
  }
}

export function getStoredSession(): RefreshableSession | undefined {
  return readSession(AUTH_FILE);
}

export function storeSession(session: RefreshableSession): void {
  if (PROFILE_EMAIL && session.account.id.toLowerCase() !== PROFILE_EMAIL) {
    throw new Error(
      `Signed in as ${session.account.id}, but COLAB_PROFILE is ${PROFILE_EMAIL}. Credentials were not saved.`,
    );
  }
  ensureProfileDir();
  fs.writeFileSync(AUTH_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
}

export function removeSession(): void {
  try {
    fs.unlinkSync(AUTH_FILE);
  } catch {
    // File may not exist
  }
}

export interface ProfileInfo {
  name: string;
  email?: string;
  active: boolean;
}

/** Local view of every profile; reads files only and makes no network calls. */
export function listProfiles(): ProfileInfo[] {
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(PROFILES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isProfileDirName(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    // No profiles directory yet
  }
  const active = ACTIVE_PROFILE ?? DEFAULT_PROFILE_NAME;
  const info = (name: string, dir: string): ProfileInfo => ({
    name,
    email: readSession(path.join(dir, 'auth.json'))?.account.id,
    active: name === active,
  });
  return [
    info(DEFAULT_PROFILE_NAME, CONFIG_DIR),
    ...names.map((name) => info(name, path.join(PROFILES_DIR, name))),
  ];
}
