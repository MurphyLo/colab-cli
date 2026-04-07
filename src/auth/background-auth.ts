import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import * as http from 'http';
import fs from 'fs';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { v4 as uuid } from 'uuid';
import {
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  REQUIRED_SCOPES,
  DRIVE_CLIENT_ID,
  DRIVE_CLIENT_SECRET,
  DRIVE_SCOPES,
  DRIVEFS_CLIENT_ID,
  DRIVEFS_CLIENT_SECRET,
  DRIVEFS_SCOPES,
  CONFIG_DIR,
  DRIVE_AUTH_FILE,
  DRIVE_MOUNT_AUTH_FILE,
} from '../config.js';
import { getStoredSession, storeSession } from './storage.js';
import { LoopbackServer, type LoopbackHandler } from './loopback-server.js';
import { EXCHANGE_TIMEOUT_MS } from './loopback-flow.js';
import { jsonResult } from '../output/json-output.js';

export type BackgroundAuthType = 'colab' | 'drive' | 'drive-mount';

interface AuthConfig {
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

function getAuthConfig(authType: BackgroundAuthType): AuthConfig {
  switch (authType) {
    case 'colab':
      return {
        clientId: OAUTH_CLIENT_ID,
        clientSecret: OAUTH_CLIENT_SECRET,
        scopes: [...REQUIRED_SCOPES].sort(),
      };
    case 'drive':
      return {
        clientId: DRIVE_CLIENT_ID,
        clientSecret: DRIVE_CLIENT_SECRET,
        scopes: [...DRIVE_SCOPES],
      };
    case 'drive-mount':
      if (!DRIVEFS_CLIENT_ID || !DRIVEFS_CLIENT_SECRET) {
        throw new Error('Drive mount credentials not configured');
      }
      return {
        clientId: DRIVEFS_CLIENT_ID,
        clientSecret: DRIVEFS_CLIENT_SECRET,
        scopes: [...DRIVEFS_SCOPES],
      };
  }
}

// ---------------------------------------------------------------------------
// Parent-side: prepare OAuth params, spawn daemon, output URL
// ---------------------------------------------------------------------------

export async function startBackgroundAuth(authType: BackgroundAuthType): Promise<void> {
  const config = getAuthConfig(authType);
  const oAuth2Client = new OAuth2Client(config.clientId, config.clientSecret);

  const pkce = await oAuth2Client.generateCodeVerifierAsync();
  const nonce = crypto.randomUUID();
  const port = await findAvailablePort();
  const redirectUri = `http://127.0.0.1:${port}`;

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    response_type: 'code',
    prompt: 'consent',
    code_challenge_method: CodeChallengeMethod.S256,
    redirect_uri: redirectUri,
    state: `nonce=${nonce}`,
    scope: config.scopes,
    code_challenge: pkce.codeChallenge,
  });

  const timeoutSeconds = EXCHANGE_TIMEOUT_MS / 1000;

  spawnDaemon({ port, nonce, codeVerifier: pkce.codeVerifier, authType });

  jsonResult({
    event: 'auth_required',
    authType,
    url: authUrl,
    timeoutSeconds,
  });
}

const DAEMON_FLAG = '--_background-auth-daemon';

function spawnDaemon(params: {
  port: number;
  nonce: string;
  codeVerifier: string;
  authType: BackgroundAuthType;
}): void {
  const thisModule = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [
    thisModule,
    DAEMON_FLAG,
    JSON.stringify(params),
  ], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error('Failed to find available port'));
      }
    });
    server.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Daemon-side: listen for OAuth callback, exchange code, save credentials
// ---------------------------------------------------------------------------

async function runAuthCallbackDaemon(opts: {
  port: number;
  nonce: string;
  codeVerifier: string;
  authType: BackgroundAuthType;
}): Promise<void> {
  const config = getAuthConfig(opts.authType);
  const oAuth2Client = new OAuth2Client(config.clientId, config.clientSecret);
  const redirectUri = `http://127.0.0.1:${opts.port}`;

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const handler: LoopbackHandler = {
    handleRequest(req, res) {
      if (!req.url || !req.headers.host) {
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method !== 'GET' || url.pathname !== '/') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const state = url.searchParams.get('state');
      if (!state) {
        res.writeHead(400);
        res.end('Missing state');
        return;
      }
      const parsedState = new URLSearchParams(state);
      const receivedNonce = parsedState.get('nonce');
      const code = url.searchParams.get('code');
      if (!receivedNonce || receivedNonce !== opts.nonce || !code) {
        res.writeHead(400);
        res.end('Invalid callback');
        return;
      }

      resolveCode(code);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<html><body><h1>Authentication successful!</h1>' +
        '<p>You can close this tab and return to the terminal.</p></body></html>',
      );
    },
  };

  const server = new LoopbackServer(handler);
  try {
    await server.start(opts.port);

    const timeout = setTimeout(() => {
      rejectCode(new Error('Authentication timed out'));
    }, EXCHANGE_TIMEOUT_MS);

    try {
      const code = await codePromise;
      clearTimeout(timeout);

      const tokenResponse = await oAuth2Client.getToken({
        code,
        codeVerifier: opts.codeVerifier,
        redirect_uri: redirectUri,
      });

      if (tokenResponse.res?.status !== 200) {
        throw new Error(`Failed to get token: ${tokenResponse.res?.statusText ?? 'unknown'}`);
      }

      const tokens = tokenResponse.tokens;
      if (!tokens.refresh_token || !tokens.access_token) {
        throw new Error('Missing credential information');
      }

      oAuth2Client.setCredentials(tokens);
      await saveCredentials(opts.authType, tokens.refresh_token, tokens.access_token);
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  } finally {
    setTimeout(() => server.dispose(), 2000);
  }
}

// ---------------------------------------------------------------------------
// Credential storage (mirrors logic in AuthManager / DriveAuthManager / MountAuthManager)
// ---------------------------------------------------------------------------

async function fetchUserInfo(token: string): Promise<{ name: string; email: string }> {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch user info: ${res.statusText}`);
  return (await res.json()) as { name: string; email: string };
}

async function fetchEmail(token: string): Promise<string | undefined> {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return undefined;
    return ((await res.json()) as { email?: string }).email;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Self-invoke: when this module is run directly as a daemon process
// ---------------------------------------------------------------------------

if (process.argv.includes(DAEMON_FLAG)) {
  const params = JSON.parse(process.argv[process.argv.indexOf(DAEMON_FLAG) + 1]);
  runAuthCallbackDaemon(params).catch(() => process.exit(1));
}

async function saveCredentials(
  authType: BackgroundAuthType,
  refreshToken: string,
  accessToken: string,
): Promise<void> {
  switch (authType) {
    case 'colab': {
      const user = await fetchUserInfo(accessToken);
      const existing = getStoredSession();
      storeSession({
        id: existing?.id ?? uuid(),
        refreshToken,
        account: { id: user.email, label: user.name },
        scopes: [...REQUIRED_SCOPES].sort(),
      });
      break;
    }
    case 'drive': {
      const email = await fetchEmail(accessToken);
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(
        DRIVE_AUTH_FILE,
        JSON.stringify({ refreshToken, clientId: DRIVE_CLIENT_ID, email }, null, 2),
        { mode: 0o600 },
      );
      break;
    }
    case 'drive-mount': {
      const email = await fetchEmail(accessToken);
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(
        DRIVE_MOUNT_AUTH_FILE,
        JSON.stringify({ refreshToken, clientId: DRIVEFS_CLIENT_ID, email }, null, 2),
        { mode: 0o600 },
      );
      break;
    }
  }
}
