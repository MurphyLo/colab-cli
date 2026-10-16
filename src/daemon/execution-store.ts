import fs from 'fs';
import path from 'path';
import type { AuthType } from '../colab/api.js';
import type { KernelOutput, ExecutionRecovery } from '../jupyter/kernel-connection.js';
import { CONFIG_DIR } from '../config.js';
import { saveOutputImages } from './image-saver.js';

export type ExecStatus = 'running' | 'reconnecting' | 'unknown' | 'input' | 'auth' | 'done' | 'error' | 'crashed';

interface Execution {
  recovery?: ExecutionRecovery;
  id: number;
  code: string;
  status: ExecStatus;
  startedAt: Date;
  finishedAt?: Date;
  outputs: KernelOutput[];
  outputCount: number; // total count (may exceed in-memory buffer)
  hasErrorOutput: boolean; // internal: tracks if any error output was seen
  errorMessage?: string;
  pendingInput?: { prompt: string; password: boolean };
  pendingAuth?: { authType: AuthType; authUrl?: string };
  /** Absolute directory where image outputs are persisted by image-saver. */
  outputDir: string;
  /** Monotonic counter for naming saved image files (exec<id>-output-<n>). */
  imageCounter: number;
}

export interface ExecListEntry {
  execId: number;
  status: ExecStatus;
  code: string;
  startedAt: string;
  finishedAt?: string;
  outputCount: number;
}

type LogEvent =
  | { event: 'checkpoint'; recovery: ExecutionRecovery; output?: KernelOutput }
  | { event: 'start'; code: string; startedAt: string; outputDir: string }
  | { event: 'output'; output: KernelOutput }
  | { event: 'done'; finishedAt: string }
  | { event: 'error'; finishedAt: string }
  | { event: 'crashed'; message: string; finishedAt: string };

const MAX_OUTPUTS_IN_MEMORY = 10_000;
const MAX_RETAINED_EXECS = 50;

export class ExecutionStore {
  private executions = new Map<number, Execution>();
  private nextId: number;
  private readonly logDir: string;
  /** Default output dir when caller doesn't pass one to create(). */
  private readonly defaultOutputDir: string;

  constructor(serverId: string) {
    this.logDir = path.join(CONFIG_DIR, `exec-logs-${serverId}`);
    this.defaultOutputDir = path.join(CONFIG_DIR, 'outputs', serverId);
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
    let hasErrorOutput = false;
    let errorMessage: string | undefined;
    const outputs: KernelOutput[] = [];
    let outputCount = 0;
    let outputDir = this.defaultOutputDir;
    let imageCounter = 0;
    let recovery: ExecutionRecovery | undefined;

    for (const line of lines) {
      let event: LogEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.event === 'checkpoint') {
        recovery = event.recovery;
        if (!event.output || event.output.type === 'input_request') continue;
        event = { event: 'output', output: event.output };
      }
      switch (event.event) {
        case 'start':
          code = event.code;
          startedAt = new Date(event.startedAt);
          if (event.outputDir) outputDir = event.outputDir;
          break;
        case 'output':
          outputCount++;
          if (outputs.length < MAX_OUTPUTS_IN_MEMORY) {
            outputs.push(event.output);
          }
          if (event.output.type === 'error') hasErrorOutput = true;
          if (
            (event.output.type === 'display_data' ||
              event.output.type === 'execute_result') &&
            event.output.savedPaths
          ) {
            imageCounter += Object.keys(event.output.savedPaths).length;
          }
          break;
        case 'done':
          status = 'done';
          finishedAt = new Date(event.finishedAt);
          break;
        case 'error':
          status = 'error';
          finishedAt = new Date(event.finishedAt);
          break;
        case 'crashed':
          status = 'crashed';
          errorMessage = event.message;
          finishedAt = new Date(event.finishedAt);
          break;
      }
    }

    // Old logs without protocol identity cannot be adopted safely.
    if (status === 'running') {
      if (recovery) {
        status = recovery.pendingInput ? 'input' : recovery.pendingAuth ? 'auth' : 'unknown';
      } else {
        status = 'crashed';
        errorMessage = 'Daemon restarted before recoverable execution tracking was saved';
        finishedAt = new Date();
        this.appendToFile(id, { event: 'crashed', message: errorMessage, finishedAt: finishedAt.toISOString() });
      }
    }

    this.executions.set(id, {
      id,
      code,
      status,
      startedAt,
      finishedAt,
      outputs,
      outputCount,
      hasErrorOutput,
      errorMessage,
      outputDir,
      imageCounter,
      recovery,
      pendingInput: status === 'input' ? recovery?.pendingInput : undefined,
      pendingAuth: status === 'auth' ? recovery?.pendingAuth : undefined,
    });
  }

  recoverable(): Execution | undefined {
    const active = [...this.executions.values()].filter(e => e.recovery && !['done', 'error', 'crashed'].includes(e.status));
    if (active.length > 1) throw new Error('Multiple unfinished kernel executions; refusing ambiguous adoption');
    return active[0];
  }

  /** Store protocol progress and output together, before exposing either to IPC. */
  checkpoint(execId: number, recovery: ExecutionRecovery, output?: KernelOutput): KernelOutput | undefined {
    const exec = this.executions.get(execId);
    if (!exec) throw new Error(`Execution ${execId} not found`);
    if (output && output.type !== 'input_request') {
      return this.appendOutput(execId, output, recovery);
    }
    this.appendToFile(execId, { event: 'checkpoint', recovery, output });
    this.applyRecovery(exec, recovery);
    return output;
  }

  private applyRecovery(exec: Execution, recovery: ExecutionRecovery): void {
    exec.recovery = structuredClone(recovery);
    exec.pendingInput = recovery.pendingInput;
    exec.pendingAuth = recovery.pendingAuth
      ? { ...exec.pendingAuth, authType: recovery.pendingAuth.authType }
      : undefined;
    if (exec.pendingInput) exec.status = 'input';
    else if (exec.pendingAuth) exec.status = 'auth';
    else if (exec.status === 'input' || exec.status === 'auth') exec.status = 'unknown';
  }

  /**
   * Create a new execution entry. Returns the exec ID.
   *
   * `outputDir` is where image outputs from this execution will be eagerly
   * saved by image-saver. Callers should pass an absolute path; if omitted,
   * a per-server default under CONFIG_DIR/outputs/<serverId>/ is used.
   */
  create(code: string, outputDir?: string): number {
    const id = this.nextId++;
    const startedAt = new Date();
    const resolvedOutputDir = outputDir ?? this.defaultOutputDir;
    const exec: Execution = {
      id,
      code,
      status: 'running',
      startedAt,
      outputs: [],
      outputCount: 0,
      hasErrorOutput: false,
      outputDir: resolvedOutputDir,
      imageCounter: 0,
    };
    this.executions.set(id, exec);
    this.appendToFile(id, {
      event: 'start',
      code,
      startedAt: startedAt.toISOString(),
      outputDir: resolvedOutputDir,
    });
    this.gc();
    return id;
  }

  /**
   * Append an output to the execution.
   *
   * If the output carries image MIME data, image-saver eagerly persists it
   * to `exec.outputDir` and the returned output gets a `savedPaths` field
   * (the original base64 in `data` is preserved). The caller should forward
   * the *returned* output to any attached client so the same savedPaths
   * surface in both attach-time replay and live streaming.
   */
  appendOutput(execId: number, output: KernelOutput, recovery?: ExecutionRecovery): KernelOutput {
    const exec = this.executions.get(execId);
    if (!exec) return output;

    const { output: stored, nextCounter } = saveOutputImages(
      output,
      execId,
      exec.outputDir,
      exec.imageCounter,
    );
    exec.imageCounter = nextCounter;

    this.appendToFile(execId, recovery
      ? { event: 'checkpoint', recovery, output: stored }
      : { event: 'output', output: stored });
    if (recovery) this.applyRecovery(exec, recovery);

    if (stored.type === 'status' && (stored.executionState === 'reconnecting' || stored.executionState === 'unknown')) {
      exec.status = exec.pendingInput ? 'input' : exec.pendingAuth ? 'auth' : stored.executionState;
    }
    exec.outputCount++;
    if (exec.outputs.length < MAX_OUTPUTS_IN_MEMORY) {
      exec.outputs.push(stored);
    }
    if (stored.type === 'error') exec.hasErrorOutput = true;
    return stored;
  }

  /** Mark execution as completed. */
  complete(execId: number): void {
    const exec = this.executions.get(execId);
    if (!exec) return;
    exec.status = exec.hasErrorOutput ? 'error' : 'done';
    exec.pendingInput = undefined;
    exec.pendingAuth = undefined;
    exec.finishedAt = new Date();
    this.appendToFile(execId, {
      event: exec.hasErrorOutput ? 'error' : 'done',
      finishedAt: exec.finishedAt.toISOString(),
    } as LogEvent);
  }

  /** Mark execution as crashed (daemon-level failure). */
  fail(execId: number, message: string): void {
    const exec = this.executions.get(execId);
    if (!exec) return;
    exec.status = 'crashed';
    exec.errorMessage = message;
    exec.finishedAt = new Date();
    this.appendToFile(execId, { event: 'crashed', message, finishedAt: exec.finishedAt.toISOString() });
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
      }));
  }

  setPendingInput(execId: number, prompt: string, password: boolean): void {
    const exec = this.executions.get(execId);
    if (!exec) return;
    exec.pendingInput = { prompt, password };
    exec.status = 'input';
  }

  clearPendingInput(execId: number): void {
    const exec = this.executions.get(execId);
    if (!exec) return;
    exec.pendingInput = undefined;
    exec.status = 'running';
  }

  setPendingAuth(execId: number, authType: AuthType, authUrl?: string): void {
    const exec = this.executions.get(execId);
    if (!exec) return;
    exec.pendingAuth = { authType, ...(authUrl ? { authUrl } : {}) };
    exec.status = 'auth';
  }

  clearPendingAuth(execId: number): void {
    const exec = this.executions.get(execId);
    if (!exec) return;
    exec.pendingAuth = undefined;
    exec.status = 'running';
  }

  /** Remove completed executions. If execId given, remove that one; otherwise remove all non-running. */
  clear(execId?: number): number {
    const ids = execId !== undefined ? [execId] : [...this.executions.keys()];
    let cleared = 0;
    for (const id of ids) {
      const exec = this.executions.get(id);
      if (exec && exec.status !== 'running' && exec.status !== 'input' && exec.status !== 'auth' && exec.status !== 'reconnecting' && exec.status !== 'unknown') {
        this.removeExecution(id);
        cleared++;
      }
    }
    return cleared;
  }

  /** Remove oldest completed executions beyond limit. */
  private gc(): void {
    if (this.executions.size <= MAX_RETAINED_EXECS) return;
    const completed = [...this.executions.values()]
      .filter((e) => ['done', 'error', 'crashed'].includes(e.status))
      .sort((a, b) => a.id - b.id);
    const toRemove = this.executions.size - MAX_RETAINED_EXECS;
    for (let i = 0; i < toRemove && i < completed.length; i++) {
      this.removeExecution(completed[i].id);
    }
  }

  private removeExecution(id: number): void {
    this.executions.delete(id);
    try {
      fs.unlinkSync(path.join(this.logDir, `${id}.ndjson`));
    } catch {}
  }

  private appendToFile(execId: number, event: LogEvent): void {
    const filePath = path.join(this.logDir, `${execId}.ndjson`);
    // Prefix a newline too: a torn final record must not swallow the next append.
    const fd = fs.openSync(filePath, 'a', 0o600);
    try {
      fs.writeFileSync(fd, '\n' + JSON.stringify(event) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }
}
