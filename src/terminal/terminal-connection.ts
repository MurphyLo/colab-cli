/**
 * WebSocket connection to a Colab runtime's TTY endpoint.
 *
 * Ported from colab-vscode `colab/terminal/colab-terminal-websocket.ts`,
 * adapted for Node.js daemon usage (no VS Code dependencies).
 *
 * Includes automatic reconnect with exponential backoff (modeled on
 * KernelConnection) and WebSocket-level ping keepalive to prevent
 * idle disconnects from Colab's infrastructure.
 */

import WebSocket from 'ws';
import { monitorWebSocket, discardWebSocket, reconnectDelay } from '../utils/websocket-health.js';
import {
  COLAB_CLIENT_AGENT_HEADER,
  COLAB_RUNTIME_PROXY_TOKEN_HEADER,
} from '../colab/headers.js';
import { log } from '../logging/index.js';
import { getProxyAgent } from '../utils/proxy.js';

interface TerminalDataMessage {
  data: string;
}

interface TerminalResizeMessage {
  cols: number;
  rows: number;
}

type TerminalMessage = TerminalDataMessage | TerminalResizeMessage;

export interface TerminalConnectionHandlers {
  onData: (data: string) => void;
  onOpen: () => void;
  onClose: (code: number, reason: string) => void;
  onError: (error: Error) => void;
  /** Called when a reconnect attempt starts. */
  onReconnecting?: (attempt: number, maxAttempts: number) => void;
  /** Called when a reconnect succeeds. */
  onReconnected?: (sendInput: (data: string) => Promise<void>) => void | Promise<void>;
}

const RECONNECT_MAX_ATTEMPTS = Infinity;
const RECONNECT_BASE_DELAY_MS = 2_000;


/**
 * Manages a WebSocket connection to `/colab/tty` for interactive terminal I/O.
 *
 * Messages are JSON-encoded:
 * - Send: `{"data": string}` for input, `{"cols": N, "rows": N}` for resize
 * - Receive: `{"data": string}` for output
 *
 * Automatically reconnects on unexpected disconnects (exponential backoff,
 * with a 30 s delay cap). Sends WebSocket-level pings every 15 s to keep the
 * connection alive across Colab's idle-timeout window.
 */
export class TerminalConnection {
  private ws?: WebSocket;
  private _closed = false;
  private _reconnecting = false;
  private reconnectGeneration = 0;
  private rejectHandshake?: (error: Error) => void;
  private _reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopHeartbeat?: () => void;

  constructor(
    private readonly getProxyUrl: () => string,
    private readonly getToken: () => string,
    private readonly handlers: TerminalConnectionHandlers,
  ) {}

  /**
   * Establishes the WebSocket connection to the Colab TTY endpoint.
   * Resolves when the connection is open and ready for I/O.
   */
  async connect(): Promise<void> {
    if (this._closed) throw new Error('TerminalConnection is closed');
    if (this.ws) throw new Error('Already connected');
    await this.connectWebSocket();
  }

  /** Send input data to the remote terminal. */
  async send(data: string): Promise<void> {
    if (this._reconnecting) throw new Error('Terminal reconnecting; input was not sent. Retry after reconnection.');
    await this.sendMessage({ data });
  }

  /** Send a resize message to update remote terminal dimensions. */
  sendResize(cols: number, rows: number): void {
    if (!this.isConnected) return;
    void this.sendMessage({ cols, rows }).catch((err) => log.debug('Resize failed:', err));
    log.trace(`Sent terminal resize: ${cols}x${rows}`);
  }

  /** Intentionally close the connection and release resources. Cancels any pending reconnect. */
  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.cancelReconnect();
    this.stopPing();
    if (this.ws) {
      this.discardSocket(this.ws);
      this.ws = undefined;
    }
  }

  get isConnected(): boolean {
    return this.ws !== undefined && this.ws.readyState === WebSocket.OPEN;
  }

  get isReconnecting(): boolean {
    return this._reconnecting;
  }

  // ── WebSocket lifecycle ──

  private connectWebSocket(): Promise<void> {
    const wsUrl = this.buildWebSocketUrl();
    log.debug('Connecting to Colab terminal:', wsUrl);

    return new Promise<void>((resolve, reject) => {
      const agent = getProxyAgent(wsUrl);
      const ws = new WebSocket(wsUrl, {
        headers: {
          [COLAB_RUNTIME_PROXY_TOKEN_HEADER.key]: this.getToken(),
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
        log.debug('Terminal WebSocket connected');
        this.startPing();
        if (!this._closed) {
          this.handlers.onOpen();
        }
        resolve();
      });

      // Post-open errors (network resets, etc.) commonly fire 'error' before
      // 'close'. Surfacing onError here would race scheduleReconnect and cause
      // the caller to mark the shell closed before the reconnect kicks in. So
      // only surface onError for pre-open failures; let 'close' drive recovery
      // for anything after the handshake.
      ws.on('error', (err) => {
        log.error('Terminal WebSocket error:', err);
        if (!opened && !this._closed) {
          this.handlers.onError(err);
        }
        if (!opened) { this.rejectHandshake = undefined; reject(err); }
        ws.terminate();
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        if (this._closed || this.ws !== ws) return;
        try {
          const text = typeof raw === 'string' ? raw : (raw as Buffer).toString();
          this.handleMessage(text);
        } catch (err) {
          log.error('Error handling terminal message:', err);
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        if (!opened) reject(new Error('Terminal WebSocket closed before opening'));
        if (this.ws !== ws) return;
        this.stopPing();
        const reasonStr = reason.toString();
        log.debug(`Terminal WebSocket closed: ${code} ${reasonStr}`);

        if (this._closed) return;

        this.ws = undefined;
        // Attempt auto-reconnect on unexpected disconnect
        if (opened) this.scheduleReconnect(code, reasonStr);
      });
    });
  }

  // ── Reconnect ──

  /**
   * Rebuild the WebSocket after an unexpected close. Exponential backoff,
   * with a capped delay and no attempt limit. The remote tmux session stays alive,
   * so reconnecting + tmux switch-client restores the shell seamlessly.
   */
  private scheduleReconnect(closeCode: number, closeReason: string): void {
    if (this._closed || this._reconnecting) return;
    this._reconnecting = true;
    const generation = this.reconnectGeneration;
    let attempt = 0;

    const tryOnce = async () => {
      if (this._closed || generation !== this.reconnectGeneration) {
        this._reconnecting = false;
        return;
      }
      attempt++;

      this.handlers.onReconnecting?.(attempt, RECONNECT_MAX_ATTEMPTS);
      log.debug(`Terminal WS reconnect attempt ${attempt}/${RECONNECT_MAX_ATTEMPTS}`);

      try {
        if (this.ws) {
          this.discardSocket(this.ws);
          this.ws = undefined;
        }
        await this.connectWebSocket();

        if (this._closed || generation !== this.reconnectGeneration) {
          this._reconnecting = false;
          return;
        }

        if (!this.isConnected) throw new Error('Terminal closed during recovery');
        log.debug(`Terminal WS reconnected (attempt ${attempt})`);
        await this.handlers.onReconnected?.((data) => this.sendMessage({ data }));
        if (!this.isConnected) throw new Error('Terminal closed while restoring session');
        this._reconnecting = false;
      } catch (err) {
        log.debug(`Terminal WS reconnect attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`);
        if (this._closed) return;
        this._reconnectTimer = setTimeout(tryOnce, reconnectDelay(attempt));
      }
    };

    this._reconnectTimer = setTimeout(tryOnce, RECONNECT_BASE_DELAY_MS);
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

  private discardSocket(ws: WebSocket): void {
    discardWebSocket(ws);
  }

  private startPing(): void {
    this.stopPing();
    if (this.ws) this.stopHeartbeat = monitorWebSocket(this.ws);
  }

  private stopPing(): void {
    this.stopHeartbeat?.();
    this.stopHeartbeat = undefined;
  }

  // ── Helpers ──

  private buildWebSocketUrl(): string {
    const proxyUrl = this.getProxyUrl();
    const wsUrl = proxyUrl.replace(/^http/, 'ws').replace(/\/$/, '');
    return `${wsUrl}/colab/tty`;
  }

  private handleMessage(rawMessage: string): void {
    let message: unknown;
    try {
      message = JSON.parse(rawMessage);
    } catch {
      log.debug('Received non-JSON terminal message:', rawMessage);
      return;
    }

    if (
      typeof message === 'object' &&
      message !== null &&
      'data' in message &&
      typeof (message as TerminalDataMessage).data === 'string'
    ) {
      this.handlers.onData((message as TerminalDataMessage).data);
    } else {
      log.trace('Received unhandled terminal message format:', message);
    }
  }

  private async sendMessage(message: TerminalMessage): Promise<void> {
    if (this._closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Terminal disconnected; input was not sent. Retry after reconnection.');
    }
    // ACK means accepted by the local transport, not executed remotely. Never
    // replay terminal input automatically: it may have side effects.
    const ws = this.ws;
    await new Promise<void>((resolve, reject) => {
      ws.send(JSON.stringify(message), (err) => err ? reject(err) : resolve());
    });
  }
}
