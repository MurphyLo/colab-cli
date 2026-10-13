import WebSocket from 'ws';

/** Detect half-open connections, including quiet kernels. Does not execute code. */
export function monitorWebSocket(
  ws: WebSocket,
  intervalMs = 15_000,
  timeoutMs = 10_000,
): () => void {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const pong = () => {
    if (deadline) clearTimeout(deadline);
    deadline = undefined;
  };
  ws.on('pong', pong);
  const interval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN || deadline) return;
    deadline = setTimeout(() => ws.terminate(), timeoutMs);
    deadline.unref();
    try { ws.ping(); } catch { ws.terminate(); }
  }, intervalMs);
  interval.unref();
  return () => {
    clearInterval(interval);
    pong();
    ws.off('pong', pong);
  };
}

/** Termination must also be safe during the opening handshake. */
export function discardWebSocket(ws: WebSocket): void {
  ws.removeAllListeners();
  ws.on('error', () => {});
  ws.terminate();
}

export function reconnectDelay(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** Math.min(attempt - 1, 4));
}
