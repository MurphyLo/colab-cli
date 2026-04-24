import http from 'http';
import https from 'https';
import net from 'net';
import httpProxy from 'http-proxy';
import { COLAB_CLIENT_AGENT_HEADER, COLAB_RUNTIME_PROXY_TOKEN_HEADER } from '../colab/headers.js';
import { log } from '../logging/index.js';
import { getProxyAgent } from '../utils/proxy.js';
import { PortTokenRefresher } from './token-refresher.js';
import type { TlsCredentials } from './tls.js';

export function createForwarder(
  refresher: PortTokenRefresher,
  tls?: TlsCredentials,
): http.Server | https.Server {
  const proxy = httpProxy.createProxyServer({
    changeOrigin: true,
    ws: true,
    secure: true,
    agent: getProxyAgent(),
  });

  proxy.on('error', (err: Error, _req: unknown, resOrSocket: http.ServerResponse | net.Socket) => {
    log.error('Port forward proxy error:', err.message);
    if (resOrSocket instanceof http.ServerResponse) {
      if (!resOrSocket.headersSent) {
        resOrSocket.writeHead(502);
      }
      resOrSocket.end(`Bad Gateway: ${err.message}`);
    } else {
      resOrSocket.destroy();
    }
  });

  const buildHeaders = () => ({
    [COLAB_RUNTIME_PROXY_TOKEN_HEADER.key]: refresher.token,
    [COLAB_CLIENT_AGENT_HEADER.key]: COLAB_CLIENT_AGENT_HEADER.value,
  });

  const proxyOrigin = new URL(refresher.proxyUrl).origin;

  // Rewrite Origin/Referer on the incoming request before proxying:
  // browsers send Origin: http://localhost:PORT for module scripts & fetch,
  // but Colab's edge proxy rejects non-matching origins with 404.
  const rewriteRequestHeaders = (req: http.IncomingMessage) => {
    if (req.headers.origin) {
      req.headers.origin = proxyOrigin;
    }
    if (req.headers.referer) {
      try {
        const u = new URL(req.headers.referer);
        const t = new URL(refresher.proxyUrl);
        u.protocol = t.protocol;
        u.host = t.host;
        req.headers.referer = u.toString();
      } catch { /* keep original if unparseable */ }
    }
  };

  const localScheme = tls ? 'https' : 'http';

  // Rewrite Access-Control-Allow-Origin in responses so the browser's CORS
  // check passes (upstream echoes the Colab proxy origin, not localhost).
  proxy.on('proxyRes', (proxyRes, req) => {
    const acao = proxyRes.headers['access-control-allow-origin'];
    if (acao && acao.includes(proxyOrigin)) {
      proxyRes.headers['access-control-allow-origin'] =
        `${localScheme}://${req.headers.host ?? 'localhost'}`;
    }
  });

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    rewriteRequestHeaders(req);
    proxy.web(req, res, {
      target: refresher.proxyUrl,
      headers: buildHeaders(),
    });
  };

  const server = tls
    ? https.createServer({ cert: tls.cert, key: tls.key }, handler)
    : http.createServer(handler);

  server.on('upgrade', (req, socket, head) => {
    rewriteRequestHeaders(req);
    proxy.ws(req, socket as net.Socket, head, {
      target: refresher.proxyUrl,
      headers: buildHeaders(),
    });
  });

  return server;
}
