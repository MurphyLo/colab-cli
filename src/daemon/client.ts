import net from 'net';
import readline from 'readline';
import { UUID } from 'crypto';
import type { AuthType } from '../colab/api.js';
import type { KernelOutput } from '../jupyter/kernel-connection.js';
import type { ClientMessage, ServerMessage, ExecStatus, ExecListEntry } from './protocol.js';
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

  async *exec(
    code: string,
    options?: {
      outputDir?: string;
      handleEphemeralAuth?: (authType: AuthType) => Promise<void>;
      handleStdinRequest?: (prompt: string, password: boolean) => Promise<string>;
    },
  ): AsyncGenerator<KernelOutput> {
    this.send({
      type: 'exec',
      code,
      ...(options?.outputDir ? { outputDir: options.outputDir } : {}),
    });
    yield* this.consumeExecMessages(options);
  }

  async execBackground(code: string, outputDir?: string): Promise<number> {
    this.send({
      type: 'exec',
      code,
      background: true,
      ...(outputDir ? { outputDir } : {}),
    });
    const msg = await this.nextMessage();
    if (msg.type === 'exec_started') return msg.execId;
    if (msg.type === 'exec_error') throw new Error(msg.message);
    throw new Error(`Unexpected response: ${msg.type}`);
  }

  async *execAttach(
    execId: number,
    options?: {
      handleEphemeralAuth?: (authType: AuthType) => Promise<void>;
      handleStdinRequest?: (prompt: string, password: boolean) => Promise<string>;
    },
  ): AsyncGenerator<KernelOutput> {
    this.send({ type: 'exec_attach', execId });
    yield* this.consumeExecMessages(options);
  }

  async execAttachSnapshot(
    execId: number,
    tail?: number,
  ): Promise<{
    outputs: KernelOutput[];
    status: ExecStatus;
    pendingInput?: { prompt: string; password: boolean };
    pendingAuth?: { authType: AuthType; authUrl?: string };
  }> {
    this.send({
      type: 'exec_attach',
      execId,
      noWait: true,
      ...(tail !== undefined ? { tail } : {}),
    });
    const msg = await this.nextMessage();
    if (msg.type === 'exec_attach_batch') {
      return {
        outputs: msg.outputs,
        status: msg.status,
        ...(msg.pendingInput ? { pendingInput: msg.pendingInput } : {}),
        ...(msg.pendingAuth ? { pendingAuth: msg.pendingAuth } : {}),
      };
    }
    if (msg.type === 'exec_error') throw new Error(msg.message);
    throw new Error(`Unexpected response: ${msg.type}`);
  }

  async execList(): Promise<ExecListEntry[]> {
    this.send({ type: 'exec_list' });
    const msg = await this.nextMessage();
    if (msg.type === 'exec_list_result') return msg.executions;
    throw new Error(`Unexpected response: ${msg.type}`);
  }

  execSend(execId: number, opts: { stdin?: string; interrupt?: boolean }): void {
    this.send({
      type: 'exec_send',
      execId,
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      ...(opts.interrupt ? { interrupt: true } : {}),
    });
  }

  async execClear(execId?: number): Promise<number> {
    this.send({ type: 'exec_clear', ...(execId !== undefined ? { execId } : {}) });
    const msg = await this.nextMessage();
    if (msg.type === 'exec_clear_result') return msg.count;
    if (msg.type === 'exec_error') throw new Error(msg.message);
    throw new Error(`Unexpected response: ${msg.type}`);
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

  private async *consumeExecMessages(
    options?: {
      handleEphemeralAuth?: (authType: AuthType) => Promise<void>;
      handleStdinRequest?: (prompt: string, password: boolean) => Promise<string>;
    },
  ): AsyncGenerator<KernelOutput> {
    while (true) {
      const msg = await this.nextMessage();
      switch (msg.type) {
        case 'auth_required': {
          let error: string | undefined;
          try {
            if (!options?.handleEphemeralAuth) {
              throw new Error('No foreground auth handler configured for this exec session');
            }
            await options.handleEphemeralAuth(msg.authType);
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
          }

          this.send({
            type: 'auth_response',
            requestId: msg.requestId,
            ...(error ? { error } : {}),
          });
          break;
        }

        case 'input_request': {
          try {
            let value = '';
            if (options?.handleStdinRequest) {
              value = await options.handleStdinRequest(msg.prompt, msg.password);
            }
            this.send({ type: 'stdin_reply', value });
          } catch {
            // Interrupted — don't send reply; kernel will be interrupted separately
          }
          break;
        }

        case 'output':
          yield msg.output;
          break;

        case 'exec_done':
          return;

        case 'exec_error':
          throw new Error(msg.message);

        default:
          break;
      }
    }
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
