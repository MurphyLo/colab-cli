import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { CONFIG_DIR, AUTH_FILE } from '../config.js';

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

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

export function getStoredSession(): RefreshableSession | undefined {
  try {
    if (!fs.existsSync(AUTH_FILE)) {
      return undefined;
    }
    const data = fs.readFileSync(AUTH_FILE, 'utf-8');
    return RefreshableSessionSchema.parse(JSON.parse(data));
  } catch {
    return undefined;
  }
}

export function storeSession(session: RefreshableSession): void {
  ensureConfigDir();
  fs.writeFileSync(AUTH_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
}

export function removeSession(): void {
  try {
    fs.unlinkSync(AUTH_FILE);
  } catch {
    // File may not exist
  }
}
