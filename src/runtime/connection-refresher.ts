import { UUID } from 'crypto';
import { ColabClient } from '../colab/client.js';
import { log } from '../logging/index.js';
import {
  isRuntimeReleasedError,
  RuntimeReleasedHandler,
} from './release-detection.js';
import { updateServerToken } from './storage.js';

const REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5 minutes before expiry
const REFRESH_RETRY_MS = 30_000;

export class ConnectionRefresher {
  private timeout?: ReturnType<typeof setTimeout>;
  private currentToken: string;
  private currentProxyUrl: string;

  constructor(
    private readonly colabClient: ColabClient,
    private readonly serverId: UUID,
    private readonly endpoint: string,
    token: string,
    proxyUrl: string,
    private tokenExpiry: Date,
    private readonly onReleased?: RuntimeReleasedHandler,
  ) {
    this.currentToken = token;
    this.currentProxyUrl = proxyUrl;
  }

  get token(): string {
    return this.currentToken;
  }

  get proxyUrl(): string {
    return this.currentProxyUrl;
  }

  start(): void {
    this.scheduleRefresh();
  }

  stop(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
  }

  private scheduleRefresh(): void {
    const msUntilRefresh = this.tokenExpiry.getTime() - REFRESH_MARGIN_MS - Date.now();
    const delay = Math.max(msUntilRefresh, 0);
    log.debug(`Next connection refresh in ${Math.round(delay / 1000)}s`);

    this.timeout = setTimeout(() => {
      this.refresh().catch((err) => {
        void this.handleRefreshFailure(err);
      });
    }, delay);
    this.timeout.unref();
  }

  private async refresh(): Promise<void> {
    log.debug('Refreshing connection token...');
    const result = await this.colabClient.refreshConnection(this.endpoint);
    this.currentToken = result.token;
    this.currentProxyUrl = result.url;
    this.tokenExpiry = new Date(Date.now() + result.tokenExpiresInSeconds * 1000);
    updateServerToken(this.serverId, result.token, result.url, this.tokenExpiry);
    log.debug('Connection token refreshed, expires:', this.tokenExpiry.toISOString());
    this.scheduleRefresh();
  }

  private async handleRefreshFailure(err: unknown): Promise<void> {
    log.error('Connection refresh failed:', err);
    if (isRuntimeReleasedError(err)) {
      this.stop();
      await this.onReleased?.(err);
      return;
    }
    this.timeout = setTimeout(() => this.scheduleRefresh(), REFRESH_RETRY_MS);
    this.timeout.unref();
  }
}
