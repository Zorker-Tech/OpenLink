/**
 * The shells that keep running after the command that started them.
 *
 * A background shell is a process the conversation can come back to, so its lifecycle is longer than the turn that
 * started it: it is started, watched, written to and read from, and eventually stopped — by the user, by its own exit,
 * or by the platform when the conversation it belongs to goes away. This is where those transitions are held, so a
 * shell that has exited is not written to, a shell nobody stopped is not forgotten, and what the shell produced is kept
 * for whoever reads it next.
 */
import { LEGACY_LOCAL_WAKEUP_CONVERSATION_ID } from "../agent-exec/background-work-registry.ts";
import { encodeBackgroundWorkMetadata } from "../agent-exec/background-work-metadata.ts";
import type { Context } from "../context/context.ts";
import type { SandboxPolicy, ShellCoreEvent } from "./shell-core.ts";

export interface ShellCompletion {
  readonly code: number | null;
  readonly aborted: boolean;
  readonly outputPath?: string;
}

export interface BackgroundShell {
  readonly id: number;
  readonly signal: AbortSignal;
  readonly pid?: number | undefined;
  readonly stdin?: NodeJS.WritableStream | undefined;
  abort(): void;
  dispose(): void;
  onComplete?(notified: (finish: ShellCompletion) => void): void;
}

export interface BackgroundSpawnContext {
  readonly ctx: Context;
  readonly shellId: number;
  readonly command: string;
  readonly workingDirectory: string;
  readonly toolCallId?: string | undefined;
  readonly conversationId?: string | undefined;
  readonly sandboxPolicy?: SandboxPolicy | undefined;
  readonly enableWriteShellStdinTool?: boolean | undefined;
  readonly description?: string | undefined;
  readonly outputNotification?: unknown;
}

export interface BackgroundAdoptState {
  readonly ctx: Context;
  readonly shellId: number;
  readonly command: string;
  readonly workingDirectory: string;
  readonly toolCallId?: string | undefined;
  readonly conversationId?: string | undefined;
  readonly sandboxPolicy?: SandboxPolicy | undefined;
  readonly initialOutput: string;
  readonly stdin?: NodeJS.WritableStream | undefined;
  readonly pid?: number | undefined;
  readonly abortController: AbortController;
  readonly eventIterator: AsyncIterator<ShellCoreEvent>;
  readonly startTime: number;
  readonly showElapsedTime: boolean;
  readonly description?: string | undefined;
  readonly outputNotification?: unknown;
}

export interface BackgroundShellFactory {
  spawn(spawnInput: BackgroundSpawnContext, coreExecutor: unknown): Promise<BackgroundShell>;
  adopt(state: BackgroundAdoptState): Promise<BackgroundShell>;
}

export interface BackgroundWorkRegistry {
  enqueue(notice: Record<string, unknown>): void;
  upsertWork(record: Record<string, unknown>): void;
  clearWork(id: string): unknown;
  abortWork(id: string): boolean;
  hasRunningWork(filter?: unknown): boolean;
  abortAllWork(filter?: unknown): number;
  listWork(filter?: unknown): unknown[];
  pull(conversationId: string): unknown[];
  ack(ids: readonly string[]): unknown[];
  nack(ids: readonly string[], opts: unknown): void;
  suppress(conversationId: string, id: string): void;
  drainCompletions(): unknown[];
  hasPendingCompletions(conversationId?: string): boolean;
  markAwaitedCompletion(taskKey: string): void;
}

export class CoreBackgroundShell implements BackgroundShell {
  readonly id: number;
  readonly abortController: AbortController;
  stdin: NodeJS.WritableStream | undefined;
  pid: number | undefined;
  private wasDisposed = false;
  private isComplete = false;
  private finish: ShellCompletion | undefined;
  private onCompleteListeners: Array<(finish: ShellCompletion) => void> = [];

  constructor(id: number, abortController: AbortController) {
    this.id = id;
    this.abortController = abortController;
  }

  abort(): void {
    this.abortController.abort();
  }

  dispose(): void {
    if (this.wasDisposed) return;
    this.wasDisposed = true;
    if (!this.abortController.signal.aborted) this.abortController.abort();
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  isDisposed(): boolean {
    return this.wasDisposed;
  }

  onComplete(notified: (finish: ShellCompletion) => void): void {
    if (this.isComplete && this.finish) {
      notified(this.finish);
      return;
    }
    this.onCompleteListeners.push(notified);
  }

  markCompleted(finish: ShellCompletion): void {
    if (this.isComplete) return;
    this.isComplete = true;
    this.finish = finish;
    const listeners = [...this.onCompleteListeners];
    this.onCompleteListeners = [];
    for (const notified of listeners) notified(finish);
  }
}

const MIN_SHELL_ID = 1_000;
const MAX_SHELL_ID = 999_999;

function randomInitialShellId(): number {
  return MIN_SHELL_ID + Math.floor(Math.random() * (MAX_SHELL_ID - MIN_SHELL_ID + 1));
}

interface ShellMetadata {
  readonly title?: string;
  readonly cwd?: string;
  readonly startTimeMs?: number;
}

/** What a manager calls a shell in the background-work list: its description, or its command. */
function shellTitle(description: unknown, command: unknown): string {
  return typeof description === "string" && description.length > 0
    ? description
    : String(command ?? "");
}

export class BackgroundShellManager {
  private readonly liveShells = new Map<number, BackgroundShell>();
  private nextId = randomInitialShellId();

  constructor(
    private readonly shellFactory: BackgroundShellFactory,
    private readonly workQueue?: BackgroundWorkRegistry,
  ) {}

  private registerShellWork(shell: BackgroundShell, shellMetadata: ShellMetadata): void {
    const shellId = String(shell.id);
    this.workQueue?.upsertWork({
      id: shellId,
      kind: "shell",
      state: "running",
      metadata: encodeBackgroundWorkMetadata(shellMetadata),
      abort: () => this.abort(shell.id),
    });
  }

  private clearShellWork(shellId: number): void {
    this.workQueue?.clearWork(String(shellId));
  }

  private cleanupShell(shellId: number): void {
    if (!this.liveShells.has(shellId)) return;
    this.liveShells.delete(shellId);
    this.clearShellWork(shellId);
  }

  private enqueueShellCompletion(
    shellId: number,
    toolCallId: string | undefined,
    conversationId: string | undefined,
    displayTitle: string,
    finish: ShellCompletion,
  ): void {
    if (!this.workQueue) return;
    const outcome = finish.aborted ? "aborted" : finish.code === 0 ? "success" : "error";
    const failureDetail = !finish.aborted && finish.code !== null && finish.code !== 0
      ? `exit_code=${finish.code}`
      : undefined;
    const taskKey = String(shellId);
    this.workQueue.enqueue({
      conversationId: conversationId ?? LEGACY_LOCAL_WAKEUP_CONVERSATION_ID,
      id: taskKey,
      source: "shell",
      payload: {
        taskId: taskKey,
        ...(toolCallId === undefined ? {} : { toolCallId }),
        kind: "shell",
        status: outcome,
        title: displayTitle,
        ...(failureDetail ? { detail: failureDetail } : {}),
        ...(finish.outputPath ? { outputPath: finish.outputPath } : {}),
        reason: "task_finished",
      },
    });
  }

  async spawn(spawnInput: BackgroundSpawnContext, coreExecutor: unknown): Promise<{ shellId: number; pid?: number | undefined }> {
    const shell = await this.shellFactory.spawn(spawnInput, coreExecutor);
    this.liveShells.set(shell.id, shell);
    this.registerShellWork(shell, {
      title: shellTitle(spawnInput.description, spawnInput.command),
      cwd: String(spawnInput.workingDirectory ?? ""),
      startTimeMs: Date.now(),
    });
    shell.signal.addEventListener("abort", () => this.cleanupShell(shell.id));
    shell.onComplete?.((finish) => {
      this.enqueueShellCompletion(
        shell.id,
        typeof spawnInput.toolCallId === "string" ? spawnInput.toolCallId : undefined,
        typeof spawnInput.conversationId === "string" ? spawnInput.conversationId : undefined,
        shellTitle(spawnInput.description, spawnInput.command),
        finish,
      );
      this.cleanupShell(shell.id);
    });
    return { shellId: shell.id, pid: shell.pid };
  }

  async adopt(state: BackgroundAdoptState): Promise<{ shellId: number; pid?: number | undefined }> {
    const shell = await this.shellFactory.adopt(state);
    this.liveShells.set(shell.id, shell);
    this.registerShellWork(shell, {
      title: shellTitle(state.description, state.command),
      cwd: String(state.workingDirectory ?? ""),
      startTimeMs: typeof state.startTime === "number" ? state.startTime : Date.now(),
    });
    shell.signal.addEventListener("abort", () => this.cleanupShell(shell.id));
    shell.onComplete?.((finish) => {
      this.enqueueShellCompletion(
        shell.id,
        typeof state.toolCallId === "string" ? state.toolCallId : undefined,
        undefined,
        shellTitle(state.description, state.command),
        finish,
      );
      this.cleanupShell(shell.id);
    });
    return { shellId: shell.id, pid: typeof state.pid === "number" ? state.pid : undefined };
  }

  generateShellId(): number {
    for (let tries = 0; tries <= MAX_SHELL_ID - MIN_SHELL_ID; tries++) {
      if (this.nextId > MAX_SHELL_ID) this.nextId = MIN_SHELL_ID;
      const nextCandidate = this.nextId;
      this.nextId += 1;
      if (!this.liveShells.has(nextCandidate)) return nextCandidate;
    }
    throw new Error("No available background shell id in range");
  }

  abort(shellId: number): boolean {
    const shell = this.liveShells.get(shellId);
    if (!shell) return false;
    shell.abort();
    this.liveShells.delete(shellId);
    this.clearShellWork(shellId);
    return true;
  }

  isRunning(shellId: number): boolean {
    return this.liveShells.has(shellId);
  }

  dispose(): void {
    for (const [shellId, shell] of this.liveShells) {
      shell.dispose();
      this.clearShellWork(shellId);
    }
    this.liveShells.clear();
  }

  async writeStdin(shellId: number, inputText: string): Promise<void> {
    const shell = this.liveShells.get(shellId);
    if (!shell) throw new Error("Shell not found");
    if (!shell.stdin) throw new Error("Shell stdin not available");
    const eotAt = inputText.indexOf("\u0004");
    const eofAt = eotAt !== -1 ? eotAt : inputText.indexOf("\\u0004");
    if (eofAt !== -1) {
      const beforeEofText = inputText.substring(0, eofAt);
      if (beforeEofText.length > 0) {
        await new Promise<void>((resolve, reject) => {
          shell.stdin?.write(beforeEofText, (error?: Error | null) => error ? reject(error) : resolve());
        });
      }
      shell.stdin.end();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      shell.stdin?.write(inputText, (error?: Error | null) => error ? reject(error) : resolve());
    });
  }
}

export class ConversationOwnerOverrideRegistry {
  constructor(
    private readonly innerRegistry: BackgroundWorkRegistry,
    private readonly ownerId: string,
  ) {}

  enqueue(notice: Record<string, unknown>): void {
    this.innerRegistry.enqueue({ ...notice, conversationId: this.ownerId });
  }

  enqueueCompletion(accepted: { readonly taskId: string; readonly kind: string; readonly [key: string]: unknown }): void {
    this.enqueue({ conversationId: this.ownerId, id: accepted.taskId, source: accepted.kind, payload: accepted });
  }

  pull(conversationId: string): unknown[] {
    return this.innerRegistry.pull(conversationId);
  }

  ack(ids: readonly string[]): unknown[] {
    return this.innerRegistry.ack(ids);
  }

  nack(ids: readonly string[], opts: unknown): void {
    this.innerRegistry.nack(ids, opts);
  }

  suppress(conversationId: string, id: string): void {
    this.innerRegistry.suppress(conversationId, id);
  }

  upsertWork(record: Record<string, unknown>): void {
    this.innerRegistry.upsertWork(record);
  }

  clearWork(id: string): unknown {
    return this.innerRegistry.clearWork(id);
  }

  abortWork(id: string): boolean {
    return this.innerRegistry.abortWork(id);
  }

  hasRunningWork(filter?: unknown): boolean {
    return this.innerRegistry.hasRunningWork(filter);
  }

  abortAllWork(filter?: unknown): number {
    return this.innerRegistry.abortAllWork(filter);
  }

  listWork(filter?: unknown): unknown[] {
    return this.innerRegistry.listWork(filter);
  }

  drainCompletions(): unknown[] {
    return this.innerRegistry.drainCompletions();
  }

  hasPendingCompletions(conversationId?: string): boolean {
    return this.innerRegistry.hasPendingCompletions(conversationId);
  }

  markAwaitedCompletion(taskKey: string): void {
    this.innerRegistry.suppress(this.ownerId, taskKey);
  }
}