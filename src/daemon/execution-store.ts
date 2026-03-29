import fs from 'fs';
import path from 'path';
import type { KernelOutput } from '../jupyter/kernel-connection.js';
import { CONFIG_DIR } from '../config.js';

export type ExecStatus = 'running' | 'done' | 'error';

export interface Execution {
  id: number;
  code: string;
  status: ExecStatus;
  startedAt: Date;
  finishedAt?: Date;
  outputs: KernelOutput[];
  outputCount: number; // total count (may exceed in-memory buffer)
  hasError: boolean;
  errorMessage?: string;
  pendingInput?: { prompt: string; password: boolean };
}

export interface ExecListEntry {
  execId: number;
  status: ExecStatus;
  code: string;
  startedAt: string;
  finishedAt?: string;
  outputCount: number;
  hasError: boolean;
}

type LogEvent =
  | { event: 'start'; code: string; startedAt: string }
  | { event: 'output'; output: KernelOutput }
  | { event: 'done' }
  | { event: 'error'; message: string };

const MAX_OUTPUTS_IN_MEMORY = 10_000;
const MAX_RETAINED_EXECS = 50;

export class ExecutionStore {
  private executions = new Map<number, Execution>();
  private nextId: number;
  private readonly logDir: string;

  constructor(serverId: string) {
    this.logDir = path.join(CONFIG_DIR, `exec-logs-${serverId}`);
    fs.mkdirSync(this.logDir, { recursive: true });
    this.nextId = this.recoverNextId();
  }

  /** Scan existing log files to find highest used ID and recover state. */
  private recoverNextId(): number {
    let maxId = 0;
    const files = fs.readdirSync(this.logDir).filter((f) => f.endsWith('.ndjson'));
    for (const file of files) {
      const id = parseInt(path.basename(file, '.ndjson'), 10);
      if (Number.isNaN(id)) continue;
      if (id > maxId) maxId = id;
      this.recoverExecution(id, path.join(this.logDir, file));
    }
    return maxId + 1;
  }

  /** Recover a single execution from its NDJSON log file. */
  private recoverExecution(id: number, filePath: string): void {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    if (lines.length === 0) return;

    let code = '';
    let startedAt = new Date();
    let status: ExecStatus = 'running';
    let finishedAt: Date | undefined;
    let hasError = false;
    let errorMessage: string | undefined;
    const outputs: KernelOutput[] = [];
    let outputCount = 0;

    for (const line of lines) {
      let event: LogEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      switch (event.event) {
        case 'start':
          code = event.code;
          startedAt = new Date(event.startedAt);
          break;
        case 'output':
          outputCount++;
          if (outputs.length < MAX_OUTPUTS_IN_MEMORY) {
            outputs.push(event.output);
          }
          if (event.output.type === 'error') hasError = true;
          break;
        case 'done':
          status = 'done';
          finishedAt = new Date();
          break;
        case 'error':
          status = 'error';
          hasError = true;
          errorMessage = event.message;
          finishedAt = new Date();
          break;
      }
    }

    // Incomplete execution = daemon crashed during run
    if (status === 'running') {
      status = 'error';
      hasError = true;
      errorMessage = 'Daemon restarted during execution';
      finishedAt = new Date();
      // Write terminal event to file
      this.appendToFile(id, { event: 'error', message: errorMessage });
    }

    this.executions.set(id, {
      id,
      code,
      status,
      startedAt,
      finishedAt,
      outputs,
      outputCount,
      hasError,
      errorMessage,
    });
  }

  /** Create a new execution entry. Returns the exec ID. */
  create(code: string): number {
    const id = this.nextId++;
    const startedAt = new Date();
    const exec: Execution = {
      id,
      code,
      status: 'running',
      startedAt,
      outputs: [],
      outputCount: 0,
      hasError: false,
    };
    this.executions.set(id, exec);
    this.appendToFile(id, {
      event: 'start',
      code,
      startedAt: startedAt.toISOString(),
    });
    this.gc();
    return id;
  }

  /** Append an output to the execution. */
  appendOutput(execId: number, output: KernelOutput): void {
    const exec = this.executions.get(execId);
    if (!exec) return;
    exec.outputCount++;
    if (exec.outputs.length < MAX_OUTPUTS_IN_MEMORY) {
      exec.outputs.push(output);
    }
    if (output.type === 'error') exec.hasError = true;
    this.appendToFile(execId, { event: 'output', output });
  }

  /** Mark execution as completed. */
  complete(execId: number): void {
    const exec = this.executions.get(execId);
    if (!exec) return;
    exec.status = 'done';
    exec.finishedAt = new Date();
    this.appendToFile(execId, { event: 'done' });
  }

  /** Mark execution as failed. */
  fail(execId: number, message: string): void {
    const exec = this.executions.get(execId);
    if (!exec) return;
    exec.status = 'error';
    exec.hasError = true;
    exec.errorMessage = message;
    exec.finishedAt = new Date();
    this.appendToFile(execId, { event: 'error', message });
  }

  /** Get outputs, optionally only the last N. */
  getOutputs(execId: number, tail?: number): KernelOutput[] {
    const exec = this.executions.get(execId);
    if (!exec) return [];
    if (tail !== undefined && tail >= 0) {
      return exec.outputs.slice(-tail);
    }
    return exec.outputs;
  }

  /** Get execution by ID. */
  get(execId: number): Execution | undefined {
    return this.executions.get(execId);
  }

  /** List all executions (newest first). */
  list(): ExecListEntry[] {
    return [...this.executions.values()]
      .sort((a, b) => b.id - a.id)
      .map((e) => ({
        execId: e.id,
        status: e.status,
        code: e.code.length > 100 ? e.code.slice(0, 100) + '...' : e.code,
        startedAt: e.startedAt.toISOString(),
        finishedAt: e.finishedAt?.toISOString(),
        outputCount: e.outputCount,
        hasError: e.hasError,
      }));
  }

  setPendingInput(execId: number, prompt: string, password: boolean): void {
    const exec = this.executions.get(execId);
    if (exec) exec.pendingInput = { prompt, password };
  }

  clearPendingInput(execId: number): void {
    const exec = this.executions.get(execId);
    if (exec) exec.pendingInput = undefined;
  }

  /** Remove oldest completed executions beyond limit. */
  private gc(): void {
    if (this.executions.size <= MAX_RETAINED_EXECS) return;
    const completed = [...this.executions.values()]
      .filter((e) => e.status !== 'running')
      .sort((a, b) => a.id - b.id);
    const toRemove = this.executions.size - MAX_RETAINED_EXECS;
    for (let i = 0; i < toRemove && i < completed.length; i++) {
      const exec = completed[i];
      this.executions.delete(exec.id);
      const logFile = path.join(this.logDir, `${exec.id}.ndjson`);
      try {
        fs.unlinkSync(logFile);
      } catch {}
    }
  }

  private appendToFile(execId: number, event: LogEvent): void {
    const filePath = path.join(this.logDir, `${execId}.ndjson`);
    fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
  }
}
