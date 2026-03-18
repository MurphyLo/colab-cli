import { HttpsProxyAgent } from 'https-proxy-agent';

export function getProxyAgent(): HttpsProxyAgent<string> | undefined {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!proxyUrl) return undefined;
  return new HttpsProxyAgent(proxyUrl);
}
