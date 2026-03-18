import * as http from 'http';

export interface LoopbackHandler {
  handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => void;
}

export class LoopbackServer {
  private listen?: Promise<number>;
  private readonly server: http.Server;
  private isDisposed = false;

  constructor(private readonly handler: LoopbackHandler) {
    this.server = http.createServer();
    this.server.on('request', (req, res) => {
      handler.handleRequest(req, res);
    });
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    if (!this.server.listening) return;
    this.server.close();
  }

  async start(): Promise<number> {
    if (this.isDisposed) {
      throw new Error('Local server has already been disposed');
    }
    if (this.listen) {
      return this.listen;
    }
    this.listen = new Promise<number>((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address();
        if (address && typeof address !== 'string') {
          resolve(address.port);
        } else {
          reject(new Error('Failed to acquire server port'));
        }
      });
    });
    return this.listen;
  }
}
