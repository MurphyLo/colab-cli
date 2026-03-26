import fs from 'fs';
import { OAuth2Client } from 'google-auth-library';
import { GaxiosError } from 'gaxios';
import {
  CONFIG_DIR,
  DRIVE_MOUNT_AUTH_FILE,
  DRIVEFS_CLIENT_ID,
  DRIVEFS_CLIENT_SECRET,
  DRIVEFS_SCOPES,
} from '../config.js';
import { runLoopbackFlow } from '../auth/loopback-flow.js';
import { log } from '../logging/index.js';
import { notifyAuthUrl } from '../output/json-output.js';

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface MountAuthSession {
  refreshToken: string;
  clientId: string;
  email?: string;
}

export class MountAuthManager {
  private oAuth2Client: OAuth2Client;
  private accessToken?: string;

  constructor() {
    if (!DRIVEFS_CLIENT_ID || !DRIVEFS_CLIENT_SECRET) {
      throw new Error(
        'Drive mount credentials not configured. ' +
        'Set COLAB_DRIVEFS_CLIENT_ID and COLAB_DRIVEFS_CLIENT_SECRET environment variables.',
      );
    }
    this.oAuth2Client = new OAuth2Client(DRIVEFS_CLIENT_ID, DRIVEFS_CLIENT_SECRET);
  }

  static isConfigured(): boolean {
    return !!DRIVEFS_CLIENT_ID && !!DRIVEFS_CLIENT_SECRET;
  }

  isAuthorized(): boolean {
    return !!this.loadStored();
  }

  async ensureAuthorized(): Promise<void> {
    const stored = this.loadStored();
    if (stored) {
      if (stored.clientId !== DRIVEFS_CLIENT_ID) {
        log.warn('Drive mount OAuth client changed, re-authorizing...');
        this.removeStored();
      } else {
        this.oAuth2Client.setCredentials({
          refresh_token: stored.refreshToken,
          token_type: 'Bearer',
        });
        try {
          await this.oAuth2Client.refreshAccessToken();
          this.accessToken = this.oAuth2Client.credentials.access_token!;
          return;
        } catch (err) {
          if (isInvalidGrantError(err)) {
            log.warn('Drive mount credentials expired, re-authorizing...');
            this.removeStored();
          } else {
            throw err;
          }
        }
      }
    }

    console.error('Drive mount authorization required.');
    console.error('This is a one-time setup. After authorization, Drive will mount automatically on new runtimes.\n');

    await runLoopbackFlow(
      this.oAuth2Client,
      [...DRIVEFS_SCOPES],
      (url) => {
        notifyAuthUrl('Drive mount authorization', url);
      },
    );

    const accessToken = this.oAuth2Client.credentials.access_token;
    const refreshToken = this.oAuth2Client.credentials.refresh_token;
    if (!accessToken || !refreshToken) {
      throw new Error('Failed to obtain Drive mount credentials');
    }

    this.accessToken = accessToken;
    const email = await this.fetchEmail(accessToken);
    this.storeCredentials({ refreshToken, clientId: DRIVEFS_CLIENT_ID!, email });
  }

  async getAccessToken(): Promise<string> {
    if (!this.accessToken) {
      await this.ensureAuthorized();
    }
    await this.refreshIfNeeded();
    return this.accessToken!;
  }

  getRefreshToken(): string {
    const stored = this.loadStored();
    if (!stored) {
      throw new Error('No Drive mount credentials found. Run `colab drive-mount login` first.');
    }
    return stored.refreshToken;
  }

  getEmail(): string | undefined {
    return this.loadStored()?.email;
  }

  async logout(): Promise<void> {
    const stored = this.loadStored();
    if (stored) {
      try {
        await this.oAuth2Client.revokeToken(stored.refreshToken);
      } catch {
        // Token may already be expired/revoked
      }
    }
    this.removeStored();
    this.accessToken = undefined;
    this.oAuth2Client.setCredentials({});
  }

  private async refreshIfNeeded(): Promise<void> {
    const expiryDateMs = this.oAuth2Client.credentials.expiry_date;
    if (expiryDateMs && expiryDateMs > Date.now() + REFRESH_MARGIN_MS) {
      return;
    }
    await this.oAuth2Client.refreshAccessToken();
    this.accessToken = this.oAuth2Client.credentials.access_token!;
  }

  private loadStored(): MountAuthSession | undefined {
    try {
      if (!fs.existsSync(DRIVE_MOUNT_AUTH_FILE)) return undefined;
      const data = JSON.parse(fs.readFileSync(DRIVE_MOUNT_AUTH_FILE, 'utf-8'));
      if (typeof data.refreshToken === 'string') {
        return { refreshToken: data.refreshToken, clientId: data.clientId ?? '', email: data.email };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private storeCredentials(session: MountAuthSession): void {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(DRIVE_MOUNT_AUTH_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
  }

  private async fetchEmail(token: string): Promise<string | undefined> {
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return undefined;
      const data = await res.json() as { email?: string };
      return data.email;
    } catch {
      return undefined;
    }
  }

  private removeStored(): void {
    try { fs.unlinkSync(DRIVE_MOUNT_AUTH_FILE); } catch { /* ignore */ }
  }
}

function isInvalidGrantError(err: unknown): boolean {
  return (
    err instanceof GaxiosError &&
    err.status === 400 &&
    err.message.includes('invalid_grant')
  );
}
