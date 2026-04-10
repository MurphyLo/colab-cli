import type { AuthType } from '../colab/api.js';
import type { KernelOutput } from '../jupyter/kernel-connection.js';
import type { ExecStatus, ExecListEntry } from './execution-store.js';

export type ClientMessage =
  | { type: 'exec'; code: string; background?: boolean; outputDir?: string }
  | { type: 'auth_response'; requestId: string; error?: string }
  | { type: 'stdin_reply'; value: string }
  | { type: 'interrupt' }
  | { type: 'restart' }
  | { type: 'ping' }
  | { type: 'exec_attach'; execId: number; noWait?: boolean; tail?: number }
  | { type: 'exec_list' }
  | { type: 'exec_send'; execId: number; stdin?: string; interrupt?: boolean }
  | { type: 'exec_clear'; execId?: number };

export type ServerMessage =
  | { type: 'ready' }
  | { type: 'auth_required'; requestId: string; authType: AuthType }
  | { type: 'input_request'; prompt: string; password: boolean }
  | { type: 'output'; output: KernelOutput }
  | { type: 'exec_done' }
  | { type: 'exec_error'; message: string }
  | { type: 'restarted' }
  | { type: 'restart_error'; message: string }
  | { type: 'pong' }
  | { type: 'exec_started'; execId: number }
  | {
      type: 'exec_attach_batch';
      execId: number;
      outputs: KernelOutput[];
      status: ExecStatus;
      pendingInput?: { prompt: string; password: boolean };
      pendingAuth?: { authType: AuthType; authUrl?: string };
    }
  | { type: 'exec_list_result'; executions: ExecListEntry[] }
  | { type: 'exec_clear_result'; count: number };

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg) + '\n';
}

export type { ExecStatus, ExecListEntry };
