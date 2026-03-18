import { ColabClient } from '../colab/client.js';
import { log } from '../logging/index.js';

const KEEP_ALIVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class KeepAlive {
  private interval?: ReturnType<typeof setInterval>;

  constructor(
    private readonly colabClient: ColabClient,
    private readonly endpoint: string,
  ) {}

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.colabClient.sendKeepAlive(this.endpoint).catch((err) => {
        log.debug('Keep-alive ping failed:', err);
      });
    }, KEEP_ALIVE_INTERVAL_MS);
    this.interval.unref();
    // Also send immediately
    this.colabClient.sendKeepAlive(this.endpoint).catch((err) => {
      log.debug('Initial keep-alive ping failed:', err);
    });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }
}
