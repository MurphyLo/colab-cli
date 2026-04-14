import http from 'http';
import net from 'net';
import httpProxy from 'http-proxy';
import { COLAB_CLIENT_AGENT_HEADER, COLAB_RUNTIME_PROXY_TOKEN_HEADER } from '../colab/headers.js';
import { log } from '../logging/index.js';
import { getProxyAgent } from '../utils/proxy.js';
import { PortTokenRefresher } from './token-refresher.js';

export function createForwarder(refresher: PortTokenRefresher): http.Server {
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

  const server = http.createServer((req, res) => {
    proxy.web(req, res, {
      target: refresher.proxyUrl,
      headers: buildHeaders(),
    });
  });

  server.on('upgrade', (req, socket, head) => {
    proxy.ws(req, socket as net.Socket, head, {
      target: refresher.proxyUrl,
      headers: buildHeaders(),
    });
  });

  return server;
}
