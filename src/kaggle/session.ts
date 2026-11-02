import { COLAB_API_DOMAIN, COLAB_GAPI_DOMAIN } from '../config.js';
import { ColabClient } from '../colab/client.js';
import { ResourcesSchema, type Resources } from '../colab/api.js';
import { KernelConnection } from '../jupyter/kernel-connection.js';
import { log } from '../logging/index.js';
import type { ConnectionProvider } from '../transfer/common.js';
import { GATEWAY_TIMEOUT_MS, sessionUnreachable, type KaggleTarget } from './url.js';

/**
 * The Kaggle gateway authenticates by the token in the URL path. The shared
 * Jupyter helpers still send Colab's proxy-token header; the gateway ignores
 * it, so any non-empty placeholder works.
 */
const PLACEHOLDER_TOKEN = 'kaggle';

/** Must match the session path KernelConnection.connect() creates. */
const CLI_SESSION_PATH = '/colab-cli';

/**
 * Colab's Jupyter root is `/`, so the shared transfer and journal code uses
 * Contents paths like `content/x` and `tmp/...` and the matching absolute
 * paths `/content/x` and `/tmp/...` inside the kernel. Kaggle's root is
 * /kaggle/working; these links make both views name the same files.
 */
const LAYOUT_LINKS = ['content', 'tmp'] as const;

const LAYOUT_CODE = `
import os as _o
for _n in ${JSON.stringify(LAYOUT_LINKS)}:
    _p = '/kaggle/working/' + _n
    if not _o.path.lexists(_p):
        _o.symlink('/' + _n, _p)
    if _o.path.realpath(_p) != '/' + _n:
        raise RuntimeError(_p + ' exists and does not point to /' + _n)
del _o, _n, _p
`;

/**
 * Kaggle's Jupyter cannot delete through the Contents API (send2trash fails
 * with HTTP 400), so KernelConnection.cleanupJournal() never succeeds there.
 * Instead, each invocation removes every other client session's journal from
 * inside the kernel before disconnecting. All CLI invocations share one
 * kernel, which executes serially, so no other execution can be writing a
 * journal while this runs.
 */
const JOURNAL_JANITOR_CODE = `
def _colab_cli_kaggle_janitor():
    import os, shutil
    from jupyter_client.session import extract_header
    k = get_ipython().kernel
    keep = extract_header(k.get_parent('shell')).get('session')
    state = getattr(k.session, '_colab_cli_journal_v1', None)
    root = '/tmp/colab-cli-journal-v1'
    if os.path.isdir(root):
        for name in os.listdir(root):
            if name != keep:
                shutil.rmtree(os.path.join(root, name), ignore_errors=True)
                if state is not None: state['sessions'].discard(name)
_colab_cli_kaggle_janitor()
del _colab_cli_kaggle_janitor
`;
const JANITOR_TIMEOUT_MS = 15_000;

export class KaggleSession {
  private layoutReady = false;

  constructor(readonly target: KaggleTarget) {}

  get base(): string {
    return this.target.base;
  }

  get endpoint(): string {
    return `kaggle-${this.target.sessionId}`;
  }

  get connection(): ConnectionProvider {
    return { getProxyUrl: () => this.base, getToken: () => PLACEHOLDER_TOKEN };
  }

  async request(apiPath: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(this.base + apiPath, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    if (isGatewayRejection(res)) throw sessionUnreachable(res.status);
    return res;
  }

  async getJson(apiPath: string): Promise<any> {
    const res = await this.request(apiPath);
    if (!res.ok) throw new Error(`GET ${apiPath} failed: HTTP ${res.status}`);
    return JSON.parse(stripXssiPrefix(await res.text()));
  }

  async status(): Promise<{ started: string; last_activity: string; kernels: number; connections: number }> {
    return this.getJson('/api/status');
  }

  async resources(): Promise<Resources> {
    return ResourcesSchema.parse(await this.getJson('/api/colab/resources'));
  }

  /** The Jupyter session (and kernel) owned by the CLI, if it exists. */
  async findCliSession(): Promise<{ id: string; kernel?: { id: string; execution_state?: string } } | undefined> {
    const sessions: any[] = await this.getJson('/api/sessions');
    return sessions.find((s) => s.path === CLI_SESSION_PATH || s.path === CLI_SESSION_PATH.slice(1));
  }

  /**
   * Connect to the CLI's kernel. Jupyter reuses the session for the fixed
   * session path, so successive CLI invocations share one kernel.
   */
  async openKernel(): Promise<KernelConnection> {
    const needsLayout = !(await this.layoutLooksReady());
    const kernel = new KernelConnection(
      () => this.base,
      () => PLACEHOLDER_TOKEN,
      unusableColabClient(),
      this.endpoint,
      'python3',
      async () => {
        throw new Error('Google credential requests are not supported in Kaggle mode');
      },
    );
    try {
      await kernel.connect();
      if (needsLayout) await this.runLayout(kernel);
      return kernel;
    } catch (err) {
      kernel.close();
      throw await this.explainConnectFailure(err);
    }
  }

  /**
   * Restart through the REST API rather than a kernel connection: connecting
   * waits for kernel_info, which a busy kernel never answers, and a busy
   * kernel is the usual reason to restart. Returns false if none exists yet.
   */
  async restartCliKernel(): Promise<boolean> {
    const id = (await this.findCliSession())?.kernel?.id;
    if (!id) return false;
    const res = await this.request(`/api/kernels/${encodeURIComponent(id)}/restart`, {
      method: 'POST',
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Kernel restart failed: HTTP ${res.status}`);
    return true;
  }

  /**
   * All invocations share one kernel, so a kernel_info request queues behind
   * any running execution, e.g. one left behind by a killed `exec`. Say so
   * instead of reporting a generic readiness timeout.
   */
  private async explainConnectFailure(err: unknown): Promise<unknown> {
    if (!(err instanceof Error) || err.message !== 'Kernel did not become ready in time') return err;
    const state = await this.findCliSession().then((s) => s?.kernel?.execution_state, () => undefined);
    if (state !== 'busy') return err;
    return new Error(
      'The CLI kernel is still busy with an earlier execution (possibly from an `exec` that was ' +
        'killed). Wait for it to finish, or run `colab runtime restart` to stop it.',
    );
  }

  /** Disconnect after clearing stale journals; never throws. */
  async closeKernel(kernel: KernelConnection): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (kernel.isConnected) {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timed out')), JANITOR_TIMEOUT_MS);
        });
        const result = await Promise.race([collectText(kernel, JOURNAL_JANITOR_CODE), timeout]);
        if (result.error) log.debug('Journal cleanup failed:', result.error);
      }
    } catch (err) {
      log.debug('Journal cleanup skipped:', String(err));
    } finally {
      clearTimeout(timer);
      kernel.close();
    }
  }

  /** Make the Colab-style paths usable before any Contents API transfer. */
  async ensureLayout(): Promise<void> {
    if (await this.layoutLooksReady()) return;
    await this.closeKernel(await this.openKernel());
  }

  private async layoutLooksReady(): Promise<boolean> {
    if (this.layoutReady) return true;
    const results = await Promise.all(
      LAYOUT_LINKS.map((name) => this.request(`/api/contents/${name}?content=0`)),
    );
    for (const res of results) {
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`Failed to inspect Kaggle file layout: HTTP ${res.status}`);
      const meta = await res.json();
      if (meta.type !== 'directory') return false;
    }
    this.layoutReady = true;
    return true;
  }

  private async runLayout(kernel: KernelConnection): Promise<void> {
    const text = await collectText(kernel, LAYOUT_CODE);
    if (text.error) throw new Error(`Failed to prepare Kaggle file layout: ${text.error}`);
    this.layoutReady = true;
  }
}

/** Run code and gather stdout/stderr text; used for helper snippets. */
export async function collectText(
  kernel: KernelConnection,
  code: string,
): Promise<{ text: string; error?: string }> {
  const parts: string[] = [];
  let error: string | undefined;
  for await (const output of await kernel.execute(code)) {
    if (output.type === 'stream') parts.push(output.text);
    if (output.type === 'error') error = `${output.ename}: ${output.evalue}`;
  }
  return { text: parts.join(''), error };
}

/**
 * KernelConnection requires a ColabClient, but only uses it for Google
 * credential requests, which Kaggle mode answers with an error instead.
 */
function unusableColabClient(): ColabClient {
  return new ColabClient(new URL(COLAB_API_DOMAIN), new URL(COLAB_GAPI_DOMAIN), async () => {
    throw new Error('Colab APIs are not available in Kaggle mode');
  });
}

/** The gateway answers unknown or expired sessions itself, in plain text. */
function isGatewayRejection(res: Response): boolean {
  if (res.status === 401 || res.status === 403) return true;
  return res.status === 404 && !res.headers.get('server')?.includes('Tornado') &&
    (res.headers.get('content-type') ?? '').startsWith('text/plain');
}

function stripXssiPrefix(v: string): string {
  return v.startsWith(")]}'") ? v.slice(v.indexOf('\n') + 1) : v;
}
