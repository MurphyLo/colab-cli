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
  onReconnected?: () => void;
}

const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 2_000;
const PING_INTERVAL_MS = 30_000;

/**
 * Manages a WebSocket connection to `/colab/tty` for interactive terminal I/O.
 *
 * Messages are JSON-encoded:
 * - Send: `{"data": string}` for input, `{"cols": N, "rows": N}` for resize
 * - Receive: `{"data": string}` for output
 *
 * Automatically reconnects on unexpected disconnects (exponential backoff,
 * up to 5 attempts). Sends WebSocket-level pings every 30 s to keep the
 * connection alive across Colab's idle-timeout window.
 */
export class TerminalConnection {
  private ws?: WebSocket;
  private _closed = false;
  private _reconnecting = false;
  private _reconnectTimer?: ReturnType<typeof setTimeout>;
  private _pingInterval?: ReturnType<typeof setInterval>;
  private pendingMessages: TerminalMessage[] = [];

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
  send(data: string): void {
    if (this._closed) return;
    this.sendMessage({ data });
  }

  /** Send a resize message to update remote terminal dimensions. */
  sendResize(cols: number, rows: number): void {
    if (this._closed) return;
    this.sendMessage({ cols, rows });
    log.trace(`Sent terminal resize: ${cols}x${rows}`);
  }

  /** Intentionally close the connection and release resources. Cancels any pending reconnect. */
  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.cancelReconnect();
    this.stopPing();
    this.pendingMessages = [];
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
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
      const agent = getProxyAgent();
      this.ws = new WebSocket(wsUrl, {
        headers: {
          [COLAB_RUNTIME_PROXY_TOKEN_HEADER.key]: this.getToken(),
          [COLAB_CLIENT_AGENT_HEADER.key]: COLAB_CLIENT_AGENT_HEADER.value,
        },
        ...(agent ? { agent } : {}),
      });

      let opened = false;

      const timeout = setTimeout(() => {
        if (this.ws) {
          this.ws.removeAllListeners();
          this.ws.close();
          this.ws = undefined;
        }
        reject(new Error('Terminal WebSocket connection timed out'));
      }, 30_000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        opened = true;
        log.debug('Terminal WebSocket connected');
        this.flushPendingMessages();
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
      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        log.error('Terminal WebSocket error:', err);
        if (!opened && !this._closed) {
          this.handlers.onError(err);
        }
        reject(err);
      });

      this.ws.on('message', (raw: WebSocket.RawData) => {
        if (this._closed) return;
        try {
          const text = typeof raw === 'string' ? raw : (raw as Buffer).toString();
          this.handleMessage(text);
        } catch (err) {
          log.error('Error handling terminal message:', err);
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        clearTimeout(timeout);
        this.stopPing();
        const reasonStr = reason.toString();
        log.debug(`Terminal WebSocket closed: ${code} ${reasonStr}`);

        if (this._closed) return;

        this.ws = undefined;
        // Attempt auto-reconnect on unexpected disconnect
        this.scheduleReconnect(code, reasonStr);
      });
    });
  }

  // ── Reconnect ──

  /**
   * Rebuild the WebSocket after an unexpected close. Exponential backoff,
   * capped at RECONNECT_MAX_ATTEMPTS. The remote tmux session stays alive,
   * so reconnecting + tmux switch-client restores the shell seamlessly.
   */
  private scheduleReconnect(closeCode: number, closeReason: string): void {
    if (this._closed || this._reconnecting) return;
    this._reconnecting = true;
    let attempt = 0;

    const tryOnce = async () => {
      if (this._closed) {
        this._reconnecting = false;
        return;
      }
      attempt++;

      this.handlers.onReconnecting?.(attempt, RECONNECT_MAX_ATTEMPTS);
      log.debug(`Terminal WS reconnect attempt ${attempt}/${RECONNECT_MAX_ATTEMPTS}`);

      try {
        if (this.ws) {
          this.ws.removeAllListeners();
          this.ws = undefined;
        }
        await this.connectWebSocket();

        if (this._closed) {
          this._reconnecting = false;
          return;
        }

        log.debug(`Terminal WS reconnected (attempt ${attempt})`);
        this._reconnecting = false;
        this.handlers.onReconnected?.();
      } catch (err) {
        log.debug(`Terminal WS reconnect attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`);
        if (attempt >= RECONNECT_MAX_ATTEMPTS || this._closed) {
          log.error(`Terminal WS reconnect gave up after ${attempt} attempts`);
          this._reconnecting = false;
          // All retries exhausted — report final close to the caller
          this.handlers.onClose(closeCode, closeReason || 'connection lost (reconnect failed)');
          return;
        }
        this._reconnectTimer = setTimeout(tryOnce, RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    };

    this._reconnectTimer = setTimeout(tryOnce, RECONNECT_BASE_DELAY_MS);
  }

  private cancelReconnect(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }
    this._reconnecting = false;
  }

  // ── Keepalive ping ──

  private startPing(): void {
    this.stopPing();
    this._pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch {
          // Swallow — onClose will fire if the socket is dead
        }
      }
    }, PING_INTERVAL_MS);
    this._pingInterval.unref();
  }

  private stopPing(): void {
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = undefined;
    }
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

  private sendMessage(message: TerminalMessage): void {
    if (!this.ws) {
      log.error('Cannot send terminal message: WebSocket not created');
      return;
    }
    if (this.ws.readyState === WebSocket.CONNECTING) {
      this.pendingMessages.push(message);
      return;
    }
    if (this.ws.readyState !== WebSocket.OPEN) {
      log.error('Cannot send terminal message: WebSocket not open');
      return;
    }
    try {
      this.ws.send(JSON.stringify(message));
    } catch (err) {
      log.error('Failed to send terminal message:', err);
    }
  }

  private flushPendingMessages(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const pending = this.pendingMessages;
    this.pendingMessages = [];
    for (const msg of pending) {
      this.sendMessage(msg);
    }
  }
}
