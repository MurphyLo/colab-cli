/**
 * Parsing for the URLs shown under Kaggle's "Run → Kaggle Jupyter Server".
 *
 * Accepted forms:
 *   - VS Code:  https://<host>/k/<session-id>/<token>/proxy
 *   - Colab:    https://<host>?token=<token>
 *   - The full "Open in Colab" link, whose `connectLocal` query parameter
 *     carries the Colab form.
 *
 * Every request is made against the VS Code form ("base"), because the token
 * lives in the path and plain path concatenation works with the existing
 * Jupyter helpers. The Colab form carries no session id, so it is resolved to
 * the base by reading the server's own base_url from /api/kernelspecs.
 */

export const KAGGLE_URL_ENV = 'COLAB_KAGGLE_URL';

export interface KaggleTarget {
  /** Jupyter base URL with the token in its path, without a trailing slash. */
  base: string;
  sessionId: string;
}

export type ParsedKaggleUrl =
  | { form: 'path'; target: KaggleTarget }
  | { form: 'query'; origin: string; token: string };

const BASE_PATH_RE = /^\/k\/([^/]+)\/([^/]+)\/proxy(?:\/|$)/;
const BASE_IN_TEXT_RE = /\/k\/([^/"\s]+)\/([^/"\s]+)\/proxy\//;

export function parseKaggleUrl(raw: string): ParsedKaggleUrl {
  let url = toUrl(raw.trim());

  // The Open-in-Colab link carries it in the fragment (#fileId=...&connectLocal=...).
  const connectLocal =
    url.searchParams.get('connectLocal') ?? new URLSearchParams(url.hash.slice(1)).get('connectLocal');
  if (connectLocal) url = toUrl(connectLocal);

  if (url.protocol !== 'https:') {
    throw new Error(`${KAGGLE_URL_ENV} must be an https:// URL`);
  }

  const match = BASE_PATH_RE.exec(url.pathname);
  if (match) {
    return {
      form: 'path',
      target: {
        base: `${url.origin}/k/${match[1]}/${match[2]}/proxy`,
        sessionId: decodeURIComponent(match[1]),
      },
    };
  }

  const token = url.searchParams.get('token');
  if (token) return { form: 'query', origin: url.origin, token };

  throw new Error(
    `${KAGGLE_URL_ENV} is not a Kaggle Jupyter Server URL. ` +
      'Copy the "VSCode Compatible URL" from Run → Kaggle Jupyter Server in the Kaggle editor.',
  );
}

/** Extract the base from a Jupyter response that embeds base_url-prefixed paths. */
export function findBaseInText(origin: string, text: string): KaggleTarget | undefined {
  const match = BASE_IN_TEXT_RE.exec(text);
  if (!match) return undefined;
  return {
    base: `${origin}/k/${match[1]}/${match[2]}/proxy`,
    sessionId: decodeURIComponent(match[1]),
  };
}

export async function resolveKaggleTarget(raw: string): Promise<KaggleTarget> {
  const parsed = parseKaggleUrl(raw);
  if (parsed.form === 'path') return parsed.target;

  const url = `${parsed.origin}/api/kernelspecs?token=${encodeURIComponent(parsed.token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw sessionUnreachable(res.status);
  const target = findBaseInText(parsed.origin, await res.text());
  if (!target) {
    throw new Error(
      `Could not derive the Kaggle session from ${KAGGLE_URL_ENV}; use the "VSCode Compatible URL" instead.`,
    );
  }
  return target;
}

export function sessionUnreachable(status: number): Error {
  return new Error(
    `Kaggle session is unreachable (HTTP ${status}). It has probably stopped; ` +
      `start the notebook session again, copy a fresh URL from Run → Kaggle Jupyter Server, ` +
      `and update ${KAGGLE_URL_ENV}.`,
  );
}

function toUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${KAGGLE_URL_ENV} is not a valid URL`);
  }
}
