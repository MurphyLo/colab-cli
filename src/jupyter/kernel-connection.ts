import WebSocket from 'ws';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { AuthType, AUTH_TYPE_VALUES } from '../colab/api.js';
import { ColabClient } from '../colab/client.js';
import {
  COLAB_CLIENT_AGENT_HEADER,
  COLAB_RUNTIME_PROXY_TOKEN_HEADER,
} from '../colab/headers.js';
import { log } from '../logging/index.js';
import { ProxiedJupyterClient } from './client/index.js';
import { getProxyAgent } from '../utils/proxy.js';

// Kernel output types
export interface StreamOutput {
  type: 'stream';
  name: 'stdout' | 'stderr';
  text: string;
}

export interface ExecuteResultOutput {
  type: 'execute_result';
  data: Record<string, string>;
  executionCount: number;
  /**
   * Absolute paths of image MIME types that the daemon eagerly persisted to disk.
   * Keyed by MIME type. The original base64 in `data` is preserved as a backup.
   */
  savedPaths?: Record<string, string>;
}

export interface DisplayDataOutput {
  type: 'display_data';
  data: Record<string, string>;
  /** See ExecuteResultOutput.savedPaths. */
  savedPaths?: Record<string, string>;
}

export interface ErrorOutput {
  type: 'error';
  ename: string;
  evalue: string;
  traceback: string[];
}

export interface StatusOutput {
  type: 'status';
  executionState: string;
}

export interface InputRequestOutput {
  type: 'input_request';
  prompt: string;
  password: boolean;
}

export type KernelOutput =
  | StreamOutput
  | ExecuteResultOutput
  | DisplayDataOutput
  | ErrorOutput
  | StatusOutput
  | InputRequestOutput;

// Jupyter message schemas for parsing
const ColabAuthRequestSchema = z.object({
  header: z.object({
    msg_type: z.literal('colab_request'),
  }),
  content: z.object({
    request: z.object({
      authType: z.enum(AUTH_TYPE_VALUES),
    }),
  }),
  metadata: z.object({
    colab_request_type: z.literal('request_auth'),
    colab_msg_id: z.number(),
  }),
});

export class KernelConnection {
  private ws?: WebSocket;
  private kernelId?: string;
  private sessionId?: string;
  private clientSessionId: string;
  private _jupyterClient?: ProxiedJupyterClient;
  private _lastProxyUrl?: string;
  private _restarting = false;
  private _closed = false;
  private _reconnecting = false;
  private _reconnectTimer?: ReturnType<typeof setTimeout>;
  private messageHandlers = new Map<string, (msg: JupyterMessage) => void>();
  /** Abort callback for the currently running executeAndStream generator. */
  private activeExecutionAbort?: (err: Error) => void;

  constructor(
    private readonly getProxyUrl: () => string,
    private readonly getToken: () => string,
    private readonly colabClient: ColabClient,
    private readonly endpoint: string,
    private readonly requestEphemeralAuth?: (authType: AuthType) => Promise<void>,
  ) {
    this.clientSessionId = uuid();
  }

  private get jupyterClient(): ProxiedJupyterClient {
    const url = this.getProxyUrl();
    if (!this._jupyterClient || this._lastProxyUrl !== url) {
      this._jupyterClient = new ProxiedJupyterClient(
        url,
        () => Promise.resolve(this.getToken()),
      );
      this._lastProxyUrl = url;
    }
    return this._jupyterClient;
  }

  async connect(): Promise<void> {
    // Create a session which gives us a kernel
    const session = await this.jupyterClient.sessions.create({
      session: {
        name: 'colab-cli',
        path: '/colab-cli',
        type: 'console',
        kernel: { id: '', name: 'python3' },
      },
    });

    this.kernelId = session.kernel?.id;
    this.sessionId = session.id;
    if (!this.kernelId) {
      throw new Error('Failed to create kernel session');
    }

    log.debug('Created kernel session:', this.kernelId);
    await this.connectWebSocket();
    await this.waitForKernelReady();
  }

  async execute(code: string): Promise<AsyncGenerator<KernelOutput>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const msgId = uuid();
    const executeRequest: JupyterMessage = {
      header: {
        msg_id: msgId,
        msg_type: 'execute_request',
        username: 'username',
        session: this.clientSessionId,
        date: new Date().toISOString(),
        version: '5.3',
      },
      parent_header: {},
      metadata: {},
      content: {
        code,
        silent: false,
        store_history: true,
        user_expressions: {},
        allow_stdin: true,
        stop_on_error: true,
      },
      channel: 'shell',
    };

    return this.executeAndStream(msgId, executeRequest);
  }

  async interrupt(): Promise<void> {
    if (!this.kernelId) return;
    await this.jupyterClient.kernels.interrupt({ kernelId: this.kernelId });
  }

  async restartKernel(): Promise<void> {
    if (!this.kernelId) return;

    this.cancelReconnect();
    this._restarting = true;
    try {
      log.debug('Restarting kernel...');

      // Close existing websocket
      if (this.ws) {
        this.ws.removeAllListeners();
        this.ws.close();
        this.ws = undefined;
      }

      // Restart via REST API
      await this.jupyterClient.kernels.restart({ kernelId: this.kernelId });

      // Reconnect WebSocket
      await this.connectWebSocket();
      await this.waitForKernelReady();
      log.debug('Kernel restarted and reconnected');
    } finally {
      this._restarting = false;
    }
  }

  sendStdinReply(value: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const reply: JupyterMessage = {
      header: {
        msg_id: uuid(),
        msg_type: 'input_reply',
        session: this.clientSessionId,
        date: new Date().toISOString(),
        username: 'username',
        version: '5.0',
      },
      content: { value },
      channel: 'stdin',
      metadata: {},
      parent_header: {},
    };

    this.ws.send(JSON.stringify(reply));
    log.trace('Stdin reply sent');
  }

  close(): void {
    this._closed = true;
    this.cancelReconnect();
    this.messageHandlers.clear();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = undefined;
    }
  }

  get isConnected(): boolean {
    return this.ws !== undefined && this.ws.readyState === WebSocket.OPEN;
  }

  get isRestarting(): boolean {
    return this._restarting;
  }

  get isReconnecting(): boolean {
    return this._reconnecting;
  }

  private cancelReconnect(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }
    this._reconnecting = false;
  }

  /**
   * Rebuild the WebSocket after an unexpected close. Exponential backoff,
   * capped at 5 attempts. Only the WS is rebuilt — the kernel process on
   * Colab stays alive, so Python state is preserved. Suppressed during
   * intentional close() / restartKernel().
   */
  private scheduleReconnect(): void {
    if (this._closed || this._restarting || this._reconnecting) return;
    this._reconnecting = true;
    const MAX_ATTEMPTS = 5;
    const BASE_DELAY_MS = 2_000;
    let attempt = 0;

    const tryOnce = async () => {
      if (this._closed || this._restarting) {
        this._reconnecting = false;
        return;
      }
      attempt++;
      try {
        if (this.ws) {
          this.ws.removeAllListeners();
          this.ws = undefined;
        }
        await this.connectWebSocket();
        // Bail if close/restart happened while connecting.
        if (this._closed || this._restarting) {
          this._reconnecting = false;
          return;
        }
        await this.waitForKernelReady();
        log.debug(`Kernel WS reconnected (attempt ${attempt})`);
        this._reconnecting = false;
      } catch (err) {
        log.debug(`Kernel WS reconnect attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`);
        if (attempt >= MAX_ATTEMPTS || this._closed || this._restarting) {
          log.error(`Kernel WS reconnect gave up after ${attempt} attempts`);
          this._reconnecting = false;
          return;
        }
        this._reconnectTimer = setTimeout(tryOnce, BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    };

    this._reconnectTimer = setTimeout(tryOnce, BASE_DELAY_MS);
  }

  private async connectWebSocket(): Promise<void> {
    const token = this.getToken();
    const wsUrl = this.getProxyUrl()
      .replace(/^http/, 'ws')
      .replace(/\/$/, '');

    const wsEndpoint = `${wsUrl}/api/kernels/${this.kernelId}/channels?session_id=${encodeURIComponent(this.clientSessionId)}`;
    log.debug('Connecting WebSocket to:', wsEndpoint);

    return new Promise<void>((resolve, reject) => {
      const agent = getProxyAgent();
      this.ws = new WebSocket(wsEndpoint, {
        headers: {
          [COLAB_RUNTIME_PROXY_TOKEN_HEADER.key]: token,
          [COLAB_CLIENT_AGENT_HEADER.key]: COLAB_CLIENT_AGENT_HEADER.value,
        },
        ...(agent ? { agent } : {}),
      });

      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timed out'));
      }, 30_000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        log.debug('WebSocket connected');
        resolve();
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        log.error('WebSocket error:', err);
        reject(err);
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString()) as JupyterMessage;
          this.handleMessage(msg);
        } catch (e) {
          log.debug('Failed to parse WebSocket message:', e);
        }
      });

      this.ws.on('close', () => {
        log.debug('WebSocket closed');
        // Abort any active execution generator so runExecution() doesn't hang.
        // Mirrors jupyter-kernel-client's _on_close → connection_ready.clear().
        if (this.activeExecutionAbort) {
          this.activeExecutionAbort(new Error('WebSocket closed during execution'));
          this.activeExecutionAbort = undefined;
        }
        // Auto-reconnect on unexpected disconnect. Guards inside scheduleReconnect
        // suppress the attempt during intentional close() / restartKernel() or when
        // a previous reconnect cycle is still active.
        this.scheduleReconnect();
      });
    });
  }

  private handleMessage(msg: JupyterMessage): void {
    log.trace('Received Jupyter message:', msg.channel, msg.header?.msg_type);

    // Handle ephemeral auth requests
    const authParse = ColabAuthRequestSchema.safeParse(msg);
    if (authParse.success) {
      const authMsg = authParse.data;
      log.trace('Colab auth request received:', authMsg);
      this.handleEphemeralAuth(
        authMsg.content.request.authType,
        authMsg.metadata.colab_msg_id,
      );
      return;
    }

    // Route to registered handlers by parent_header.msg_id
    const parentMsgId = msg.parent_header?.msg_id;
    if (parentMsgId) {
      const handler = this.messageHandlers.get(parentMsgId);
      if (handler) {
        handler(msg);
        return;
      }
    }

    // Handle kernel_info_reply for waiting
    if (msg.header?.msg_type === 'status') {
      // Detect kernel restart: a status:starting broadcast means the kernel
      // process was replaced (crash auto-restart or explicit restart).  Any
      // in-flight execution will never receive its execute_reply/idle pair,
      // so abort the generator to unblock runExecution().
      if (msg.content?.execution_state === 'starting' && this.activeExecutionAbort) {
        log.debug('Kernel restarted while execution active — aborting execution');
        this.activeExecutionAbort(new Error('Kernel restarted during execution'));
        this.activeExecutionAbort = undefined;
      }

      const handler = this.messageHandlers.get('__kernel_status__');
      if (handler) {
        handler(msg);
      }
    }
  }

  private handleEphemeralAuth(authType: string, colabMsgId: number): void {
    const executeAuth = this.requestEphemeralAuth
      ? this.requestEphemeralAuth(authType as AuthType)
      : import('../auth/ephemeral.js').then(({ handleEphemeralAuth }) =>
        handleEphemeralAuth(this.colabClient, this.endpoint, authType as AuthType),
      );

    executeAuth
      .then(() => {
        this.sendInputReply(colabMsgId);
      })
      .catch((err: unknown) => {
        log.error('Ephemeral auth failed:', err);
        this.sendInputReply(
          colabMsgId,
          err instanceof Error ? err.message : 'unknown error',
        );
      });
  }

  private sendInputReply(colabMsgId: number, error?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const reply: JupyterMessage = {
      header: {
        msg_id: uuid(),
        msg_type: 'input_reply',
        session: this.clientSessionId,
        date: new Date().toISOString(),
        username: 'username',
        version: '5.0',
      },
      content: {
        value: {
          type: 'colab_reply',
          colab_msg_id: colabMsgId,
          ...(error ? { error } : {}),
        },
      },
      channel: 'stdin',
      metadata: {},
      parent_header: {},
    };

    this.ws.send(JSON.stringify(reply));
    log.trace('Input reply sent for colab_msg_id:', colabMsgId);
  }

  private waitForKernelReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const msgId = uuid();
      const timeout = setTimeout(() => {
        this.messageHandlers.delete(msgId);
        reject(new Error('Kernel did not become ready in time'));
      }, 60_000);

      this.messageHandlers.set(msgId, (msg) => {
        const msgType = msg.header?.msg_type;
        const channel = msg.channel;

        // A shell reply confirms the kernel is responsive.
        if (channel === 'shell' && msgType === 'kernel_info_reply') {
          clearTimeout(timeout);
          this.messageHandlers.delete(msgId);
          resolve();
          return;
        }

        // Some kernels also emit a matching iopub idle transition.
        if (channel === 'iopub' && msgType === 'status' && msg.content?.execution_state === 'idle') {
          clearTimeout(timeout);
          this.messageHandlers.delete(msgId);
          resolve();
        }
      });

      const kernelInfoRequest: JupyterMessage = {
        header: {
          msg_id: msgId,
          msg_type: 'kernel_info_request',
          username: 'username',
          session: this.clientSessionId,
          date: new Date().toISOString(),
          version: '5.3',
        },
        parent_header: {},
        metadata: {},
        content: {},
        channel: 'shell',
      };

      this.ws.send(JSON.stringify(kernelInfoRequest));
    });
  }

  private async *executeAndStream(
    msgId: string,
    request: JupyterMessage,
  ): AsyncGenerator<KernelOutput> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    type QueueItem = { output: KernelOutput } | { done: true } | { error: Error };

    const queue: QueueItem[] = [];
    let resolve: (() => void) | undefined;
    let waiting: Promise<void> | undefined;

    const push = (item: QueueItem) => {
      queue.push(item);
      if (resolve) {
        resolve();
        resolve = undefined;
        waiting = undefined;
      }
    };

    // Track both signals: execute_reply (shell) and status:idle (iopub).
    // Per Jupyter protocol, iopub status:idle is guaranteed to arrive AFTER
    // all output messages. execute_reply on shell may arrive before iopub
    // messages are delivered. We mark done only when both have been received.
    let gotExecuteReply = false;
    let gotIdle = false;

    const maybeFinish = () => {
      if (gotExecuteReply && gotIdle) {
        push({ done: true });
      }
    };

    const handler = (msg: JupyterMessage) => {
      const msgType = msg.header?.msg_type;
      const channel = msg.channel;

      // Handle stdin input_request (Python input() / getpass())
      if (channel === 'stdin' && msgType === 'input_request') {
        push({
          output: {
            type: 'input_request',
            prompt: msg.content?.prompt ?? '',
            password: msg.content?.password ?? false,
          },
        });
        return;
      }

      if (channel === 'iopub') {
        switch (msgType) {
          case 'stream':
            push({
              output: {
                type: 'stream',
                name: msg.content.name,
                text: msg.content.text,
              },
            });
            break;
          case 'execute_result':
            push({
              output: {
                type: 'execute_result',
                data: msg.content.data ?? {},
                executionCount: msg.content.execution_count,
              },
            });
            break;
          case 'display_data':
          case 'update_display_data':
            push({
              output: {
                type: 'display_data',
                data: msg.content.data ?? {},
              },
            });
            break;
          case 'error':
            push({
              output: {
                type: 'error',
                ename: msg.content.ename,
                evalue: msg.content.evalue,
                traceback: msg.content.traceback ?? [],
              },
            });
            break;
          case 'status':
            if (msg.content.execution_state === 'idle') {
              gotIdle = true;
              maybeFinish();
            }
            break;
        }
      }

      // Track execute_reply on shell channel
      if (channel === 'shell' && msgType === 'execute_reply') {
        gotExecuteReply = true;
        maybeFinish();
      }
    };

    this.messageHandlers.set(msgId, handler);

    // Register abort callback so external events (WS close, kernel restart)
    // can unblock this generator instead of hanging forever.
    this.activeExecutionAbort = (err: Error) => push({ error: err });

    // Send the execute request
    this.ws.send(JSON.stringify(request));

    try {
      while (true) {
        if (queue.length === 0) {
          waiting = new Promise<void>((r) => {
            resolve = r;
          });
          await waiting;
        }

        while (queue.length > 0) {
          const item = queue.shift()!;
          if ('done' in item) {
            return;
          }
          if ('error' in item) {
            throw item.error;
          }
          yield item.output;
        }
      }
    } finally {
      this.messageHandlers.delete(msgId);
      this.activeExecutionAbort = undefined;
    }
  }
}

// Generic Jupyter message shape
interface JupyterMessage {
  header: Record<string, any>;
  parent_header: Record<string, any>;
  metadata: Record<string, any>;
  content: Record<string, any>;
  channel?: string;
}
