import { ColabClient } from '../colab/client.js';
import { log } from '../logging/index.js';
import {
  isRuntimeReleasedError,
  RuntimeReleasedHandler,
} from './release-detection.js';

const KEEP_ALIVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class KeepAlive {
  private interval?: ReturnType<typeof setInterval>;

  constructor(
    private readonly colabClient: ColabClient,
    private readonly endpoint: string,
    private readonly onReleased?: RuntimeReleasedHandler,
  ) {}

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.colabClient.sendKeepAlive(this.endpoint).catch((err) => {
        void this.handlePingFailure('Keep-alive ping failed:', err);
      });
    }, KEEP_ALIVE_INTERVAL_MS);
    this.interval.unref();
    // Also send immediately
    this.colabClient.sendKeepAlive(this.endpoint).catch((err) => {
      void this.handlePingFailure('Initial keep-alive ping failed:', err);
    });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  private async handlePingFailure(prefix: string, err: unknown): Promise<void> {
    if (isRuntimeReleasedError(err)) {
      log.error(prefix, err);
      this.stop();
      await this.onReleased?.(err);
      return;
    }
    log.debug(prefix, err);
  }
}
