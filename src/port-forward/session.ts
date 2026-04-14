import http from 'http';
import { ColabClient } from '../colab/client.js';
import { createForwarder } from './forwarder.js';
import { PortTokenRefresher } from './token-refresher.js';

export class ForwardSession {
  readonly startedAt = new Date();

  private constructor(
    readonly id: number,
    readonly localHost: string,
    readonly localPort: number,
    readonly remotePort: number,
    private readonly refresher: PortTokenRefresher,
    private readonly server: http.Server,
  ) {}

  get proxyUrl(): string {
    return this.refresher.proxyUrl;
  }

  static async open(
    id: number,
    localHost: string,
    localPort: number,
    remotePort: number,
    colabClient: ColabClient,
    endpoint: string,
  ): Promise<ForwardSession> {
    const refresher = new PortTokenRefresher(colabClient, endpoint, remotePort);
    await refresher.start();

    const server = createForwarder(refresher);
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(localPort, localHost);
      });
    } catch (err) {
      refresher.stop();
      throw err;
    }

    return new ForwardSession(id, localHost, localPort, remotePort, refresher, server);
  }

  async close(): Promise<void> {
    this.refresher.stop();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }
}
