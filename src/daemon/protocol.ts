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
  | { type: 'exec_clear'; execId?: number }
  | { type: 'shell_open'; cols: number; rows: number }
  | { type: 'shell_input'; shellId: number; data: string }
  | { type: 'shell_resize'; shellId: number; cols: number; rows: number }
  | { type: 'shell_detach'; shellId: number }
  | { type: 'shell_attach'; shellId: number; cols?: number; rows?: number; noWait?: boolean; tail?: number }
  | { type: 'shell_list' }
  | { type: 'shell_send'; shellId: number; data: string }
  | { type: 'port_forward_create'; localPort: number; remotePort: number }
  | { type: 'port_forward_list' }
  | { type: 'port_forward_close'; id?: number; all?: boolean };

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
  | { type: 'exec_clear_result'; count: number }
  | { type: 'shell_opened'; shellId: number }
  | { type: 'shell_output'; shellId: number; data: string }
  | { type: 'shell_closed'; shellId: number; reason: string }
  | { type: 'shell_error'; message: string }
  | { type: 'shell_attached'; shellId: number; buffered: string }
  | { type: 'shell_attach_batch'; shellId: number; buffered: string; status: ShellStatus }
  | { type: 'shell_list_result'; shells: ShellListEntry[] }
  | { type: 'shell_send_ack'; shellId: number }
  | {
      type: 'port_forward_created';
      id: number;
      localPort: number;
      remotePort: number;
      proxyUrl: string;
    }
  | { type: 'port_forward_list_result'; sessions: PortForwardListEntry[] }
  | { type: 'port_forward_closed'; ids: number[] }
  | { type: 'port_forward_error'; message: string };

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg) + '\n';
}

export type ShellStatus = 'running' | 'closed';

export interface ShellListEntry {
  shellId: number;
  status: ShellStatus;
  startedAt: string;
  attached: boolean;
}

export interface PortForwardListEntry {
  id: number;
  localPort: number;
  remotePort: number;
  startedAt: string;
  proxyUrl: string;
}

export type { ExecStatus, ExecListEntry };
