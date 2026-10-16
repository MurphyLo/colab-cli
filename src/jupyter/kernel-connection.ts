import WebSocket from 'ws';
import { JOURNAL_BOOTSTRAP, readJournal, JournalIntegrityError, removeJournal } from './kernel-journal.js';
import { monitorWebSocket, discardWebSocket, reconnectDelay } from '../utils/websocket-health.js';
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
  message?: string;
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

/** Serializable protocol state. Persist before sending code or acknowledging output. */
export interface ExecutionRecovery {
  kernelId: string;
  clientSessionId: string;
  msgId: string;
  gotExecuteReply: boolean;
  gotIdle: boolean;
  gotError: boolean;
  replyError?: ErrorOutput;
  pendingInput?: InputRequestOutput;
  journal?: { version: 1; cursor: number };
  pendingInputReplyId?: string;
  pendingAuth?: { authType: AuthType; colabMsgId: number };
}

export type ExecutionCheckpoint = (state: ExecutionRecovery, output?: KernelOutput) => KernelOutput | undefined;

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
  private reconnectGeneration = 0;
  private rejectHandshake?: (error: Error) => void;
  private _reconnectTimer?: ReturnType<typeof setTimeout>;
  private pendingAuthReplies = new Map<number, string | undefined>();
  private stopHeartbeat?: () => void;
  private activeConnectionStatus?: (state: string) => void;
  private messageHandlers = new Map<string, (msg: JupyterMessage) => void>();
  /** Abort callback for the currently running executeAndStream generator. */
  private activeExecutionAbort?: (err: Error) => void;
  private recovery?: ExecutionRecovery;
  private checkpoint?: ExecutionCheckpoint;
  private authInFlight = new Set<number>();
  private journalReady = false;
  private journalRequired = false;
  private installingJournal = false;
  private reconcileJournal?: () => Promise<void>;

  constructor(
    private readonly getProxyUrl: () => string,
    private readonly getToken: () => string,
    private readonly colabClient: ColabClient,
    private readonly endpoint: string,
    private readonly kernelName: string = 'python3',
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
    // Map user-facing kernel names to Jupyter kernelspec names
    const kernelSpecName = this.kernelName === 'r' ? 'ir' : this.kernelName;
    const session = await this.jupyterClient.sessions.create({
      session: {
        name: 'colab-cli',
        path: '/colab-cli',
        type: 'console',
        kernel: { id: '', name: kernelSpecName },
      },
    });

    if (this._closed) throw new Error('Kernel connection closed');
    this.kernelId = session.kernel?.id;
    this.sessionId = session.id;
    if (!this.kernelId) {
      throw new Error('Failed to create kernel session');
    }

    log.debug('Created kernel session:', this.kernelId);
    await this.connectWebSocket();
    await this.waitForKernelReady();
    await this.installJournal();
  }

  private async installJournal(): Promise<void> {
    this.journalReady = false;
    if (this.kernelName !== 'python3') return;
    this.journalRequired = true;
    const code = JOURNAL_BOOTSTRAP + "\n_colab_cli_install_journal(" + JSON.stringify(this.clientSessionId) + ")";
    this.installingJournal = true;
    const timer = setTimeout(() => this.activeExecutionAbort?.(new Error('Kernel journal installation timed out; user code was not submitted')), 30_000);
    try {
      const stream = await this.execute(code);
      for await (const output of stream) {
        if (output.type === 'error') throw new Error('Kernel journal installation failed: ' + output.evalue);
      }
      this.journalReady = true;
    } finally { clearTimeout(timer); this.installingJournal = false; }
  }

  async execute(code: string, checkpoint?: ExecutionCheckpoint): Promise<AsyncGenerator<KernelOutput>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    if (this.journalRequired && !this.journalReady && !this.installingJournal) await this.installJournal();
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
        silent: this.installingJournal,
        store_history: !this.installingJournal,
        user_expressions: {},
        allow_stdin: !this.installingJournal,
        stop_on_error: !this.installingJournal,
      },
      channel: 'shell',
    };

    if (!this.kernelId) throw new Error('Kernel identity unavailable');
    const state: ExecutionRecovery = {
      kernelId: this.kernelId, clientSessionId: this.clientSessionId, msgId,
      gotExecuteReply: false, gotIdle: false, gotError: false,
      ...(this.journalReady ? { journal: { version: 1 as const, cursor: 0 } } : {}),
    };
    return this.executeAndStream(state, executeRequest, checkpoint);
  }

  /** Register the original request before opening a socket that may immediately replay. */
  resume(state: ExecutionRecovery, checkpoint: ExecutionCheckpoint): AsyncGenerator<KernelOutput> {
    this.kernelId = state.kernelId;
    this.clientSessionId = state.clientSessionId;
    this.journalReady = !!state.journal;
    this.journalRequired = this.kernelName === 'python3';
    return this.executeAndStream(structuredClone(state), undefined, checkpoint);
  }

  /** Only call after the daemon durably records the terminal event. */
  async cleanupJournal(state?: ExecutionRecovery): Promise<void> {
    if (!state?.journal || !state.gotExecuteReply || !state.gotIdle) return;
    try { await removeJournal(this.getProxyUrl(), this.getToken(), state.clientSessionId, state.msgId); }
    catch (error) { log.debug('Retaining completed remote journal:', String(error)); }
  }

  async interrupt(): Promise<void> {
    if (!this.kernelId) return;
    await this.jupyterClient.kernels.interrupt({ kernelId: this.kernelId });
  }

  async restartKernel(): Promise<void> {
    if (!this.kernelId) {
      // No kernel session means initial connect() never succeeded or the
      // session was never established. Treat as a hard error so callers
      // (daemon → client → CLI spinner) can't report false success.
      throw new Error(
        'No kernel session to restart — initial kernel connect did not complete. ' +
        'Run `colab runtime list` to confirm the runtime is still alive; if not, recreate it.',
      );
    }

    this.cancelReconnect();
    this.stopHeartbeat?.();
    this.pendingAuthReplies.clear();
    this.activeExecutionAbort?.(new Error('Kernel explicitly restarted during execution'));
    this._restarting = true;
    try {
      log.debug('Restarting kernel...');

      // Close existing websocket
      if (this.ws) {
        discardWebSocket(this.ws);
        this.ws = undefined;
      }

      // Restart via REST API
      await this.jupyterClient.kernels.restart({ kernelId: this.kernelId });

      // Reconnect WebSocket
      await this.connectWebSocket();
      await this.waitForKernelReady();
      await this.installJournal();
      log.debug('Kernel restarted and reconnected');
    } finally {
      this._restarting = false;
    }
  }

  async sendStdinReply(value: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Kernel disconnected; input was not sent. Retry after reconnection.');
    }

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

    const ws = this.ws;
    const owner = this.recovery;
    if (owner?.journal) {
      if (owner.pendingInputReplyId) throw new Error('Previous input delivery is unverified; refusing to send a second answer. Wait for recovery or interrupt the execution.');
      owner.pendingInputReplyId = reply.header.msg_id;
      this.checkpoint?.(owner);
    }
    const pendingInput = owner?.pendingInput;
    await new Promise<void>((resolve, reject) => {
      ws.send(JSON.stringify(reply), (err) => err ? reject(err) : resolve());
    });
    if (this.recovery && !owner?.journal && this.recovery === owner && this.recovery.pendingInput === pendingInput) {
      this.recovery.pendingInput = undefined;
      this.checkpoint?.(this.recovery);
    }
    log.trace('Stdin reply sent');
  }

  close(): void {
    this._closed = true;
    this.cancelReconnect();
    this.stopHeartbeat?.();
    this.activeExecutionAbort?.(new Error('Kernel connection closed; remote execution may still be running'));
    this.messageHandlers.clear();
    if (this.ws) {
      discardWebSocket(this.ws);
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
    this.reconnectGeneration++;
    this.rejectHandshake?.(new Error('Connection attempt cancelled'));
    this.rejectHandshake = undefined;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }
    this._reconnecting = false;
  }

  /** Reconnect the same kernel and client session until explicitly closed. */
  private scheduleReconnect(): void {
    if (this._closed || this._restarting || this._reconnecting) return;
    this._reconnecting = true;
    this.activeConnectionStatus?.('reconnecting');
    const generation = this.reconnectGeneration;
    let attempt = 0;
    const tryOnce = async () => {
      if (this._closed || this._restarting || generation !== this.reconnectGeneration) return;
      attempt++;
      try {
        await this.connectWebSocket();
        if (this._closed || this._restarting || generation !== this.reconnectGeneration) return;
        if (!this.isConnected) throw new Error('Connection closed during recovery');
        // Never enqueue a kernel_info probe behind a running execution or infer
        // its outcome from a probe reply. Buffered messages retain their handler.
        this._reconnecting = false;
        void this.reconcileJournal?.();
        this.activeConnectionStatus?.('unknown');
        log.debug(`Kernel WS reconnected (attempt ${attempt})`);
      } catch (err) {
        if (this._closed || this._restarting || generation !== this.reconnectGeneration) return;
        log.debug(`Kernel WS reconnect attempt ${attempt} failed: ${err}`);
        this._reconnectTimer = setTimeout(tryOnce, reconnectDelay(attempt));
      }
    };
    this._reconnectTimer = setTimeout(tryOnce, reconnectDelay(1));
  }

  private async connectWebSocket(): Promise<void> {
    const token = this.getToken();
    const wsUrl = this.getProxyUrl()
      .replace(/^http/, 'ws')
      .replace(/\/$/, '');

    const wsEndpoint = `${wsUrl}/api/kernels/${this.kernelId}/channels?session_id=${encodeURIComponent(this.clientSessionId)}`;
    log.debug('Connecting WebSocket to:', wsEndpoint);

    return new Promise<void>((resolve, reject) => {
      const agent = getProxyAgent(wsEndpoint);
      const ws = new WebSocket(wsEndpoint, {
        headers: {
          [COLAB_RUNTIME_PROXY_TOKEN_HEADER.key]: token,
          [COLAB_CLIENT_AGENT_HEADER.key]: COLAB_CLIENT_AGENT_HEADER.value,
        },
        ...(agent ? { agent } : {}),
        handshakeTimeout: 30_000,
      });
      this.ws = ws;
      let opened = false;
      this.rejectHandshake = reject;
      ws.on('open', () => {
        opened = true;
        this.rejectHandshake = undefined;
        this.stopHeartbeat?.();
        this.stopHeartbeat = monitorWebSocket(ws);
        for (const [id, error] of this.pendingAuthReplies) this.sendInputReply(id, error);
        this.pendingAuthReplies.clear();
        resolve();
      });
      ws.on('error', (err) => {
        if (!opened) { this.rejectHandshake = undefined; reject(err); }
        ws.terminate();
      });
      ws.on('message', (data: WebSocket.RawData) => {
        if (this.ws !== ws) return;
        try { this.handleMessage(JSON.parse(data.toString()) as JupyterMessage); }
        catch (err) { log.debug('Failed to handle WebSocket message:', err); }
      });
      ws.on('close', () => {
        if (!opened) reject(new Error('Kernel WebSocket closed before opening'));
        if (this.ws !== ws) return;
        this.stopHeartbeat?.();
        this.ws = undefined;
        if (opened) this.scheduleReconnect();
      });
    });
  }

  private handleMessage(msg: JupyterMessage): void {
    log.trace('Received Jupyter message:', msg.channel, msg.header?.msg_type);

    // Journal messages, including Colab requests without parent msg_id, use one ordered path.
    const tag = msg.metadata?.colab_cli_journal;
    if (tag && this.recovery?.journal && tag.exec === this.recovery.msgId) {
      this.messageHandlers.get(tag.exec)?.(msg);
      return;
    }
    // Handle ephemeral auth requests
    const authParse = ColabAuthRequestSchema.safeParse(msg);
    if (authParse.success) {
      const authMsg = authParse.data;
      if (this.recovery?.journal) { void this.reconcileJournal?.(); return; }
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
      if (msg.content?.execution_state === 'starting') this.journalReady = false;
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
    if (this.authInFlight.has(colabMsgId)) return;
    const owner = this.recovery;
    if (this.recovery) {
      this.recovery.pendingAuth = { authType: authType as AuthType, colabMsgId };
      this.checkpoint?.(this.recovery);
    }
    this.authInFlight.add(colabMsgId);
    const executeAuth = this.requestEphemeralAuth
      ? this.requestEphemeralAuth(authType as AuthType)
      : import('../auth/ephemeral.js').then(({ handleEphemeralAuth }) =>
        handleEphemeralAuth(this.colabClient, this.endpoint, authType as AuthType),
      );

    executeAuth
      .then(() => {
        if (owner === this.recovery) this.sendInputReply(colabMsgId);
      })
      .catch((err: unknown) => {
        if (owner !== this.recovery) return;
        log.error('Ephemeral auth failed:', err);
        this.sendInputReply(
          colabMsgId,
          err instanceof Error ? err.message : 'unknown error',
        );
      }).finally(() => this.authInFlight.delete(colabMsgId));
  }

  private sendInputReply(colabMsgId: number, error?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (!this._closed) this.pendingAuthReplies.set(colabMsgId, error);
      return;
    }

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

    this.ws.send(JSON.stringify(reply), (err) => {
      if (err) {
        if (!this._closed) this.pendingAuthReplies.set(colabMsgId, error);
        return;
      }
      if (this.recovery?.pendingAuth?.colabMsgId === colabMsgId) {
        this.recovery.pendingAuth = undefined;
        this.checkpoint?.(this.recovery);
      }
    });
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
    state: ExecutionRecovery,
    request?: JupyterMessage,
    checkpoint?: ExecutionCheckpoint,
  ): AsyncGenerator<KernelOutput> {
    if (request && (!this.ws || this.ws.readyState !== WebSocket.OPEN)) {
      throw new Error('WebSocket not connected');
    }
    const msgId = state.msgId;
    this.recovery = state;
    this.checkpoint = checkpoint;
    checkpoint?.(state);

    type QueueItem = { output: KernelOutput } | { done: true } | { error: Error };

    const queue: QueueItem[] = [];
    let resolve: (() => void) | undefined;
    let waiting: Promise<void> | undefined;

    const push = (item: QueueItem) => {
      if ('output' in item) item.output = checkpoint?.(state, item.output) ?? item.output;
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
    let finished = false;

    const maybeFinish = () => {
      if (state.gotExecuteReply && state.gotIdle && !finished) {
        finished = true;
        if (state.replyError && !state.gotError) {
          state.gotError = true;
          push({ output: state.replyError });
        }
        checkpoint?.(state);
        push({ done: true });
      }
    };

    const handler = (msg: JupyterMessage) => {
      const auth = ColabAuthRequestSchema.safeParse(msg);
      if (auth.success) {
        this.handleEphemeralAuth(auth.data.content.request.authType, auth.data.metadata.colab_msg_id);
        return;
      }
      const msgType = msg.header?.msg_type;
      if (msgType === 'colab_cli_input_received') {
        if (msg.content.reply_msg_id === state.pendingInputReplyId) {
          state.pendingInput = undefined;
          state.pendingInputReplyId = undefined;
          checkpoint?.(state);
        }
        return;
      }
      const channel = msg.channel;

      // Handle stdin input_request (Python input() / getpass())
      if (channel === 'stdin' && msgType === 'input_request') {
        state.pendingInputReplyId = undefined;
        state.pendingInput = { type: 'input_request', prompt: msg.content?.prompt ?? '', password: msg.content?.password ?? false };
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
            state.gotError = true;
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
              state.gotIdle = true;
              state.pendingInput = undefined;
              state.pendingAuth = undefined;
              checkpoint?.(state);
              maybeFinish();
            }
            break;
        }
      }

      // Track execute_reply on shell channel
      if (channel === 'shell' && msgType === 'execute_reply') {
        if (msg.content.status === 'error' || msg.content.status === 'aborted') {
          state.replyError = { type: 'error', ename: msg.content.ename ?? 'ExecutionAborted',
            evalue: msg.content.evalue ?? 'Execution aborted', traceback: msg.content.traceback ?? [] };
        }
        state.gotExecuteReply = true;
        checkpoint?.(state);
        maybeFinish();
      }
    };

    const pending = new Map<number, JupyterMessage>();
    let stopped = false;
    let syncing = false;
    const ingest = (msg: JupyterMessage) => {
      if (!state.journal) { handler(msg); return; }
      const tag = msg.metadata?.colab_cli_journal;
      if (!tag || tag.exec !== msgId) { void reconcile(); return; }
      if (!tag.ok || !Number.isSafeInteger(tag.seq) || tag.seq < 1) {
        push({ error: new JournalIntegrityError('Remote execution journal failed; output completeness cannot be verified') });
        return;
      }
      if (tag.seq <= state.journal.cursor) return;
      pending.set(tag.seq, msg);
      while (pending.has(state.journal.cursor + 1)) {
        const seq = state.journal.cursor + 1;
        const next = pending.get(seq)!;
        pending.delete(seq);
        state.journal.cursor = seq;
        try { handler(next); checkpoint?.(state); }
        catch (error) { stopped = true; push({ error: error instanceof Error ? error : new Error(String(error)) }); return; }
      }
      if (pending.size) void reconcile();
    };
    const reconcile = async () => {
      if (!state.journal || stopped || finished || syncing) return;
      syncing = true;
      try {
        const rows = await readJournal(this.getProxyUrl(), this.getToken(), state.clientSessionId, msgId, state.journal.cursor);
        if (!stopped) for (const row of rows) ingest(row);
      } catch (error) {
        if (!stopped && error instanceof JournalIntegrityError) push({ error });
        else log.debug('Journal reconciliation deferred:', String(error));
      } finally { syncing = false; }
    };
    this.reconcileJournal = reconcile;
    const journalTimer = state.journal ? setInterval(() => { void reconcile(); }, 3000) : undefined;
    journalTimer?.unref();
    this.messageHandlers.set(msgId, ingest);

    // Register callbacks so external events can unblock this generator.
    this.activeExecutionAbort = (err: Error) => push({ error: err });

    this.activeConnectionStatus = (state) => push({ output: {
      type: 'status', executionState: state,
      message: state === 'reconnecting'
        ? 'Connection lost; reconnecting without resubmitting code. Remote execution may still be running.'
        : 'Execution outcome is unverified; waiting for the original reply and idle. Some output may be missing.',
    } });

    try {
      // Never retry this send: a failed delivery acknowledgement is ambiguous.
      if (request) {
        const reportStatus = this.activeConnectionStatus;
        this.ws!.send(JSON.stringify(request), (err) => {
          if (err) reportStatus?.('unknown');
        });
      } else {
        this.activeConnectionStatus('unknown');
        if (state.pendingInput) push({ output: state.pendingInput });
        maybeFinish();
        // No session creation, kernel_info probe, or execute_request on adoption.
        void reconcile();
        try { await this.connectWebSocket(); }
        catch { this.scheduleReconnect(); }
        if (state.pendingAuth) {
          this.handleEphemeralAuth(state.pendingAuth.authType, state.pendingAuth.colabMsgId);
        }
      }
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
      stopped = true;
      if (journalTimer) clearInterval(journalTimer);
      this.reconcileJournal = undefined;
      this.messageHandlers.delete(msgId);
      this.activeExecutionAbort = undefined;
      this.activeConnectionStatus = undefined;
      this.recovery = undefined;
      this.checkpoint = undefined;
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
