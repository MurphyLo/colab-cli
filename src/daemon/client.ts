import net from 'net';
import readline from 'readline';
import { UUID } from 'crypto';
import type { KernelOutput } from '../jupyter/kernel-connection.js';
import type { ClientMessage, ServerMessage } from './protocol.js';
import { encode } from './protocol.js';
import { getSocketPath, isDaemonRunning, startDaemon } from './lifecycle.js';

export class DaemonClient {
  private socket?: net.Socket;
  private rl?: readline.Interface;
  private messageQueue: ServerMessage[] = [];
  private waitResolve?: () => void;
  private closed = false;

  async connect(serverId: UUID): Promise<void> {
    if (!isDaemonRunning(serverId)) {
      await startDaemon(serverId);
    }

    const socketPath = getSocketPath(serverId);
    this.socket = await new Promise<net.Socket>((resolve, reject) => {
      const sock = net.connect(socketPath, () => resolve(sock));
      sock.on('error', reject);
    });

    this.closed = false;
    this.rl = readline.createInterface({ input: this.socket });
    this.rl.on('line', (line) => {
      try {
        this.messageQueue.push(JSON.parse(line) as ServerMessage);
        if (this.waitResolve) {
          this.waitResolve();
          this.waitResolve = undefined;
        }
      } catch {}
    });

    this.socket.on('close', () => {
      this.closed = true;
      if (this.waitResolve) {
        this.waitResolve();
        this.waitResolve = undefined;
      }
    });

    this.socket.on('error', () => {});

    const ready = await this.nextMessage();
    if (ready.type !== 'ready') {
      throw new Error(`Expected 'ready' from daemon, got '${ready.type}'`);
    }
  }

  async *exec(code: string): AsyncGenerator<KernelOutput> {
    this.send({ type: 'exec', code });
    while (true) {
      const msg = await this.nextMessage();
      if (msg.type === 'output') {
        yield msg.output;
      } else if (msg.type === 'exec_done') {
        return;
      } else if (msg.type === 'exec_error') {
        throw new Error(msg.message);
      }
    }
  }

  async restart(): Promise<void> {
    this.send({ type: 'restart' });
    const msg = await this.nextMessage();
    if (msg.type === 'restart_error') {
      throw new Error(msg.message);
    }
  }

  interrupt(): void {
    this.send({ type: 'interrupt' });
  }

  close(): void {
    this.rl?.close();
    this.socket?.destroy();
    this.socket = undefined;
    this.rl = undefined;
    this.closed = true;
  }

  private send(msg: ClientMessage): void {
    if (!this.socket || this.closed) throw new Error('Not connected to daemon');
    this.socket.write(encode(msg));
  }

  private async nextMessage(): Promise<ServerMessage> {
    while (this.messageQueue.length === 0) {
      if (this.closed) throw new Error('Daemon connection closed unexpectedly');
      await new Promise<void>((r) => {
        this.waitResolve = r;
      });
    }
    return this.messageQueue.shift()!;
  }
}
