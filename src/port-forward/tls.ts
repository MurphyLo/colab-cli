import fs from 'fs';
import path from 'path';
import { generate } from 'selfsigned';
import { CONFIG_DIR } from '../config.js';

const CERT_FILE = path.join(CONFIG_DIR, 'port-forward-cert.pem');
const KEY_FILE = path.join(CONFIG_DIR, 'port-forward-key.pem');

export interface TlsCredentials {
  cert: string;
  key: string;
}

export async function getTlsCredentials(): Promise<TlsCredentials> {
  try {
    const cert = fs.readFileSync(CERT_FILE, 'utf-8');
    const key = fs.readFileSync(KEY_FILE, 'utf-8');
    return { cert, key };
  } catch {
    // not cached yet — generate
  }

  const notAfterDate = new Date();
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 10);

  const attrs = [{ name: 'commonName', value: 'colab-cli port-forward' }];
  const pems = await generate(attrs, {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate,
  });

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CERT_FILE, pems.cert, { mode: 0o600 });
  fs.writeFileSync(KEY_FILE, pems.private, { mode: 0o600 });

  return { cert: pems.cert, key: pems.private };
}
