import fs from 'fs';
import { UUID } from 'crypto';
import { z } from 'zod';
import { Variant } from '../colab/api.js';

const VARIANTS = ['DEFAULT', 'GPU', 'TPU'] as const;
import { CONFIG_DIR, SERVERS_FILE } from '../config.js';
import { isUUID } from '../utils/uuid.js';

const StoredServerSchema = z.object({
  id: z
    .string()
    .refine(isUUID)
    .transform((s) => s as UUID),
  label: z.string(),
  variant: z.enum(VARIANTS),
  accelerator: z.string().optional(),
  endpoint: z.string(),
  proxyUrl: z.string(),
  token: z.string(),
  tokenExpiry: z.coerce.date(),
  dateAssigned: z.coerce.date(),
  kernelName: z.string().optional().default('python3'),
});

export type StoredServer = z.infer<typeof StoredServerSchema>;

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

export function listStoredServers(): StoredServer[] {
  try {
    if (!fs.existsSync(SERVERS_FILE)) return [];
    const data = fs.readFileSync(SERVERS_FILE, 'utf-8');
    return z.array(StoredServerSchema).parse(JSON.parse(data));
  } catch {
    return [];
  }
}

export function getStoredServer(id: UUID): StoredServer | undefined {
  return listStoredServers().find((s) => s.id === id);
}

export function storeServer(server: StoredServer): void {
  ensureConfigDir();
  const existing = listStoredServers().filter((s) => s.id !== server.id);
  existing.push(server);
  fs.writeFileSync(SERVERS_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 });
}

export function removeStoredServer(id: UUID): boolean {
  const servers = listStoredServers();
  const filtered = servers.filter((s) => s.id !== id);
  if (filtered.length === servers.length) return false;
  ensureConfigDir();
  fs.writeFileSync(SERVERS_FILE, JSON.stringify(filtered, null, 2), { mode: 0o600 });
  return true;
}

export function updateServerToken(
  id: UUID,
  token: string,
  proxyUrl: string,
  tokenExpiry: Date,
): void {
  const servers = listStoredServers();
  const server = servers.find((s) => s.id === id);
  if (!server) return;
  server.token = token;
  server.proxyUrl = proxyUrl;
  server.tokenExpiry = tokenExpiry;
  ensureConfigDir();
  fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2), { mode: 0o600 });
}
