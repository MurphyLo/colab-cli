import type { AuthType } from '../colab/api.js';
import type { KernelOutput } from '../jupyter/kernel-connection.js';

export type ClientMessage =
  | { type: 'exec'; code: string }
  | { type: 'auth_response'; requestId: string; error?: string }
  | { type: 'stdin_reply'; value: string }
  | { type: 'interrupt' }
  | { type: 'restart' }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'ready' }
  | { type: 'auth_required'; requestId: string; authType: AuthType }
  | { type: 'input_request'; prompt: string; password: boolean }
  | { type: 'output'; output: KernelOutput }
  | { type: 'exec_done' }
  | { type: 'exec_error'; message: string }
  | { type: 'restarted' }
  | { type: 'restart_error'; message: string }
  | { type: 'pong' };

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg) + '\n';
}
