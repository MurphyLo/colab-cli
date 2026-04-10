import fs from 'fs';
import path from 'path';
import type { AuthType } from '../colab/api.js';
import type { KernelOutput } from '../jupyter/kernel-connection.js';
import { CONFIG_DIR } from '../config.js';
import { saveOutputImages } from './image-saver.js';

export type ExecStatus = 'running' | 'input' | 'auth' | 'done' | 'error' | 'crashed';

interface Execution {
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

    // Incomplete execution = daemon crashed during run
    if (status === 'running') {
      status = 'crashed';
      errorMessage = 'Daemon restarted during execution';
      finishedAt = new Date();
      this.appendToFile(id, { event: 'crashed', message: errorMessage, finishedAt: finishedAt.toISOString() });
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
    });
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
  appendOutput(execId: number, output: KernelOutput): KernelOutput {
    const exec = this.executions.get(execId);
    if (!exec) return output;

    const { output: stored, nextCounter } = saveOutputImages(
      output,
      execId,
      exec.outputDir,
      exec.imageCounter,
    );
    exec.imageCounter = nextCounter;

    exec.outputCount++;
    if (exec.outputs.length < MAX_OUTPUTS_IN_MEMORY) {
      exec.outputs.push(stored);
    }
    if (stored.type === 'error') exec.hasErrorOutput = true;
    this.appendToFile(execId, { event: 'output', output: stored });
    return stored;
  }

  /** Mark execution as completed. */
  complete(execId: number): void {
    const exec = this.executions.get(execId);
    if (!exec) return;
    exec.status = exec.hasErrorOutput ? 'error' : 'done';
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
      if (exec && exec.status !== 'running' && exec.status !== 'input' && exec.status !== 'auth') {
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
      .filter((e) => e.status !== 'running')
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
    fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
  }
}
