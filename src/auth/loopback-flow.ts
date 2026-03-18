import assert from 'assert';
import * as http from 'http';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import open from 'open';
import { LoopbackServer, LoopbackHandler } from './loopback-server.js';

const EXCHANGE_TIMEOUT_MS = 120_000;

interface FlowResult {
  code: string;
  redirectUri: string;
}

export async function runLoopbackFlow(
  oAuth2Client: OAuth2Client,
  scopes: string[],
): Promise<FlowResult> {
  const pkce = await oAuth2Client.generateCodeVerifierAsync();
  const nonce = crypto.randomUUID();

  let resolveCode: (code: string) => void;
  let rejectCode: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const handler: LoopbackHandler = {
    handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
      assert(req.url);
      assert(req.headers.host);
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
      if (!receivedNonce || receivedNonce !== nonce || !code) {
        res.writeHead(400);
        res.end('Invalid callback');
        return;
      }

      resolveCode(code);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>Authentication successful!</h1><p>You can close this tab and return to the terminal.</p></body></html>');
    },
  };

  const server = new LoopbackServer(handler);
  try {
    const port = await server.start();
    const address = `http://127.0.0.1:${port}`;

    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      response_type: 'code',
      prompt: 'consent',
      code_challenge_method: CodeChallengeMethod.S256,
      redirect_uri: address,
      state: `nonce=${nonce}`,
      scope: scopes,
      code_challenge: pkce.codeChallenge,
    });

    await open(authUrl);

    const timeout = setTimeout(() => {
      rejectCode(new Error('Authentication timed out'));
    }, EXCHANGE_TIMEOUT_MS);

    try {
      const code = await codePromise;
      clearTimeout(timeout);

      const tokenResponse = await oAuth2Client.getToken({
        code,
        codeVerifier: pkce.codeVerifier,
        redirect_uri: address,
      });

      if (tokenResponse.res?.status !== 200) {
        throw new Error(`Failed to get token: ${tokenResponse.res?.statusText ?? 'unknown'}`);
      }

      const tokens = tokenResponse.tokens;
      if (!tokens.refresh_token || !tokens.access_token || !tokens.expiry_date || !tokens.scope) {
        throw new Error('Missing credential information');
      }

      oAuth2Client.setCredentials(tokens);
      return { code, redirectUri: address };
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  } finally {
    // Give a moment for the success page to load, then dispose
    setTimeout(() => server.dispose(), 2000);
  }
}
