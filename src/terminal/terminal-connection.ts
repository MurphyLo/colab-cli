/**
 * WebSocket connection to a Colab runtime's TTY endpoint.
 *
 * Ported from colab-vscode `colab/terminal/colab-terminal-websocket.ts`,
 * adapted for Node.js daemon usage (no VS Code dependencies).
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
}

/**
 * Manages a WebSocket connection to `/colab/tty` for interactive terminal I/O.
 *
 * Messages are JSON-encoded:
 * - Send: `{"data": string}` for input, `{"cols": N, "rows": N}` for resize
 * - Receive: `{"data": string}` for output
 */
export class TerminalConnection {
  private ws?: WebSocket;
  private disposed = false;
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
  connect(): Promise<void> {
    if (this.disposed) throw new Error('TerminalConnection is disposed');
    if (this.ws) throw new Error('Already connected');

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

      const timeout = setTimeout(() => {
        reject(new Error('Terminal WebSocket connection timed out'));
      }, 30_000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        log.debug('Terminal WebSocket connected');
        this.flushPendingMessages();
        if (!this.disposed) {
          this.handlers.onOpen();
        }
        resolve();
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        log.error('Terminal WebSocket error:', err);
        if (!this.disposed) {
          this.handlers.onError(err);
        }
        reject(err);
      });

      this.ws.on('message', (raw: WebSocket.RawData) => {
        if (this.disposed) return;
        try {
          const text = typeof raw === 'string' ? raw : (raw as Buffer).toString();
          this.handleMessage(text);
        } catch (err) {
          log.error('Error handling terminal message:', err);
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        clearTimeout(timeout);
        log.debug(`Terminal WebSocket closed: ${code} ${reason.toString()}`);
        if (!this.disposed) {
          this.ws = undefined;
          this.handlers.onClose(code, reason.toString());
        }
      });
    });
  }

  /** Send input data to the remote terminal. */
  send(data: string): void {
    if (this.disposed) return;
    this.sendMessage({ data });
  }

  /** Send a resize message to update remote terminal dimensions. */
  sendResize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.sendMessage({ cols, rows });
    log.trace(`Sent terminal resize: ${cols}x${rows}`);
  }

  /** Close the WebSocket and release resources. */
  close(): void {
    if (this.disposed) return;
    this.disposed = true;
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
