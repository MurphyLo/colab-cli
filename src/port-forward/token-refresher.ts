import { ColabClient } from '../colab/client.js';
import { log } from '../logging/index.js';

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class PortTokenRefresher {
  private timeout?: ReturnType<typeof setTimeout>;
  private currentToken = '';
  private currentProxyUrl = '';
  private tokenExpiry = new Date(0);
  private started = false;

  constructor(
    private readonly colabClient: ColabClient,
    private readonly endpoint: string,
    private readonly port: number,
  ) {}

  get token(): string {
    return this.currentToken;
  }

  get proxyUrl(): string {
    return this.currentProxyUrl;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.fetchToken();
    this.started = true;
    this.scheduleRefresh();
  }

  stop(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
    this.started = false;
  }

  private scheduleRefresh(): void {
    const msUntilRefresh = this.tokenExpiry.getTime() - REFRESH_MARGIN_MS - Date.now();
    const delay = Math.max(msUntilRefresh, 0);
    log.debug(`Port ${this.port}: next token refresh in ${Math.round(delay / 1000)}s`);

    this.timeout = setTimeout(() => {
      this.fetchToken()
        .then(() => this.scheduleRefresh())
        .catch((err) => {
          log.error(`Port ${this.port}: token refresh failed:`, err);
          this.timeout = setTimeout(() => this.scheduleRefresh(), 30_000);
          this.timeout.unref();
        });
    }, delay);
    this.timeout.unref();
  }

  private async fetchToken(): Promise<void> {
    const result = await this.colabClient.refreshConnection(this.endpoint, this.port);
    this.currentToken = result.token;
    this.currentProxyUrl = result.url;
    this.tokenExpiry = new Date(Date.now() + result.tokenExpiresInSeconds * 1000);
    log.debug(
      `Port ${this.port}: token refreshed, expires ${this.tokenExpiry.toISOString()}, url ${result.url}`,
    );
  }
}
