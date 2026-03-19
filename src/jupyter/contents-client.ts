import {
  COLAB_CLIENT_AGENT_HEADER,
  COLAB_RUNTIME_PROXY_TOKEN_HEADER,
  CONTENT_TYPE_JSON_HEADER,
  ACCEPT_JSON_HEADER,
} from '../colab/headers.js';
import { log } from '../logging/index.js';

export function encodeContentsPath(remotePath: string): string {
  return `/api/contents/${remotePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

export async function contentsRequest(
  proxyUrl: string,
  token: string,
  apiPath: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const method = (options.method ?? 'GET').toUpperCase();
  const url = proxyUrl.replace(/\/$/, '') + apiPath;
  const headers: Record<string, string> = {
    [ACCEPT_JSON_HEADER.key]: ACCEPT_JSON_HEADER.value,
    [COLAB_CLIENT_AGENT_HEADER.key]: COLAB_CLIENT_AGENT_HEADER.value,
    [COLAB_RUNTIME_PROXY_TOKEN_HEADER.key]: token,
  };
  if (options.body !== undefined) {
    headers[CONTENT_TYPE_JSON_HEADER.key] = CONTENT_TYPE_JSON_HEADER.value;
  }

  log.debug(`contents ${method} ${apiPath}`);

  const res = await fetch(url, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(
      `HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`,
    );
    (err as any).status = res.status;
    throw err;
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function getContentsMetadata(
  proxyUrl: string,
  token: string,
  remotePath: string,
): Promise<any> {
  return contentsRequest(
    proxyUrl,
    token,
    `${encodeContentsPath(remotePath)}?content=0`,
  );
}

export async function putFileBase64(
  proxyUrl: string,
  token: string,
  remotePath: string,
  base64Content: string,
): Promise<any> {
  return contentsRequest(proxyUrl, token, encodeContentsPath(remotePath), {
    method: 'PUT',
    body: {
      type: 'file',
      format: 'base64',
      content: base64Content,
    },
  });
}

export async function getFileBase64Content(
  proxyUrl: string,
  token: string,
  remotePath: string,
): Promise<{ content: string; size: number }> {
  const result: any = await contentsRequest(
    proxyUrl,
    token,
    `${encodeContentsPath(remotePath)}?format=base64&type=file`,
  );
  if (!result || typeof result.content !== 'string') {
    throw new Error(`Unexpected response format for ${remotePath}`);
  }
  return { content: result.content, size: Number(result.size) };
}

export async function putDirectory(
  proxyUrl: string,
  token: string,
  dirPath: string,
): Promise<any> {
  return contentsRequest(proxyUrl, token, encodeContentsPath(dirPath), {
    method: 'PUT',
    body: { type: 'directory' },
  });
}
