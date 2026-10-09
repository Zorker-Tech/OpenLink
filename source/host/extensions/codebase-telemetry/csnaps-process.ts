/**
 * The codebase-telemetry helper as a process.
 *
 * It is started with the frames the protocol defines, its answers are decoded as they arrive, and it is stopped by
 * asking it to shut down before the pipe is closed.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { DeadlinePolicy } from "../scheduling.ts";
import { CsnapsResponseDecoder, encodeCsnapsRequest, parseCsnapsOperationResult, type CsnapsErrorCode, type CsnapsOperation, type CsnapsResponse } from "./csnaps-protocol.ts";

export class CsnapsProcessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CsnapsProcessError";
  }
}

/** The helper answered, and the answer was a refusal the caller can act on. */
export class CsnapsRequestError extends CsnapsProcessError {
  constructor(readonly method: string, readonly code: CsnapsErrorCode) {
    super(`csnaps ${method} request failed: ${code}`);
    this.name = "CsnapsRequestError";
  }
}

export interface CsnapsDeadlines {
  ping: DeadlinePolicy;
  initialize: DeadlinePolicy;
  applyCodebaseSpecs: DeadlinePolicy;
  snapshot: DeadlinePolicy;
  triggerUpload: DeadlinePolicy;
  flushPendingUploads: DeadlinePolicy;
  shutdown: DeadlinePolicy;
  exit: DeadlinePolicy;
}

export interface CsnapsProcessState {
  readonly tracked: readonly { readonly codebaseUuid: string; readonly path: string; readonly kind: number; readonly environment: number }[];
}

/** One request waiting for its answer, together with the deadline it runs under. */
interface PendingRequest {
  readonly method: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  readonly deadlineSignal: AbortSignal;
  onDeadline(): void;
}

export interface CsnapsSpawnOptions {
  executablePath: string;
  initializeParams: Record<string, unknown>;
  deadlines: CsnapsDeadlines;
  signal?: AbortSignal;
}

export class CsnapsProcess {
  readonly terminalFailure: Promise<Error>;
  private readonly resolveTerminalFailure: (error: Error) => void;
  private readonly childExited: Promise<void>;
  private terminalError: Error | undefined;
  private closePromise: Promise<void> | undefined;
  private isClosing = false;
  private nextRequestId = 0;
  private readonly awaitingAnswer = new Map<number, PendingRequest>();
  private readonly answers = new CsnapsResponseDecoder();

  constructor(private readonly child: ChildProcessByStdio<Writable, Readable, null>, private readonly deadlines: CsnapsDeadlines) {
    const terminal = Promise.withResolvers<Error>();
    this.terminalFailure = terminal.promise;
    this.resolveTerminalFailure = terminal.resolve;
    this.childExited = new Promise((resolve) => child.once("close", (code, signal) => {
      // An exit nobody asked for is the helper's failure; one we asked for is the end of a shutdown that was
      // already answered for. What it exited with is only worth saying when nothing else went wrong first.
      let error = this.terminalError;
      if (error == null) {
        try {
          this.answers.assertComplete();
          error = new CsnapsProcessError(describeCsnapsExit(code, signal));
        } catch (cause) {
          error = cause instanceof Error ? cause : new CsnapsProcessError("invalid csnaps response", { cause });
        }
      }
      this.terminalError = error;
      this.rejectAllAwaiting(error);
      if (!this.isClosing) this.resolveTerminalFailure(error);
      resolve();
    }));
    child.once("error", (error) => this.fail(new CsnapsProcessError(`csnaps child process failed: ${error.message}`, { cause: error })));
    child.stdin.on("error", (error) => this.fail(new CsnapsProcessError(`csnaps stdin failed: ${error.message}`, { cause: error })));
    child.stdout.on("error", (error) => this.fail(new CsnapsProcessError(`csnaps stdout failed: ${error.message}`, { cause: error })));
    child.stdout.on("data", (chunk: Buffer) => this.handleAnswers(chunk));
  }

  /** Starts the helper and waits for it to say it is up, so a caller only ever gets a helper that answered. */
  static async spawn(options: CsnapsSpawnOptions): Promise<{ handle: CsnapsProcess; initialState: CsnapsProcessState }> {
    options.signal?.throwIfAborted();
    const helper = new CsnapsProcess(spawn(options.executablePath, [], { env: {}, stdio: ["pipe", "pipe", "inherit"] }), options.deadlines);
    try {
      await helper.ping(options.signal);
      const initialized = await helper.initialize(options.initializeParams, options.signal);
      return { handle: helper, initialState: initialized.state };
    } catch (error) {
      try {
        await helper.terminate();
      } catch {}
      throw error;
    }
  }

  async initialize(params: Record<string, unknown>, signal?: AbortSignal): Promise<{ state: CsnapsProcessState }> {
    const operation = { method: "initialize" as const, params };
    return parseCsnapsOperationResult(operation, await this.request(operation, signal)) as { state: CsnapsProcessState };
  }

  async applyCodebaseSpecs(codebases: readonly unknown[], signal?: AbortSignal): Promise<{ state: CsnapsProcessState; rejected: readonly unknown[] }> {
    const operation = { method: "apply_codebase_specs" as const, params: { codebases } };
    return parseCsnapsOperationResult(operation, await this.request(operation, signal)) as { state: CsnapsProcessState; rejected: readonly unknown[] };
  }

  async snapshot(reason: unknown, signal?: AbortSignal): Promise<void> {
    const operation = { method: "snapshot" as const, params: { reason } };
    parseCsnapsOperationResult(operation, await this.request(operation, signal));
  }

  async triggerUpload(credentials: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const operation = { method: "trigger_upload" as const, params: credentials };
    parseCsnapsOperationResult(operation, await this.request(operation, signal));
  }

  async flushPendingUploads(credentials: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const operation = { method: "flush_pending_uploads" as const, params: credentials };
    parseCsnapsOperationResult(operation, await this.request(operation, signal));
  }

  async ping(signal?: AbortSignal): Promise<void> {
    const operation = { method: "ping" as const };
    parseCsnapsOperationResult(operation, await this.request(operation, signal));
  }

  /** Asks the helper to shut down, and takes it down when it will not. */
  close(): Promise<void> {
    this.isClosing = true;
    return (this.closePromise ??= this.shutdown());
  }

  async terminate(): Promise<void> {
    if (this.child.exitCode != null || this.child.signalCode != null) {
      await this.waitForExit("exit");
      return;
    }
    this.child.stdin.destroy();
    this.child.kill("SIGTERM");
    try {
      await this.waitForExit("SIGTERM");
    } catch {
      this.child.kill("SIGKILL");
      await this.waitForExit("SIGKILL");
    }
  }

  private async shutdown(): Promise<void> {
    try {
      const operation = { method: "shutdown" as const };
      parseCsnapsOperationResult(operation, await this.request(operation));
      await this.waitForExit("shutdown");
    } catch {
      await this.terminate();
    }
  }

  private async waitForExit(trigger: string): Promise<void> {
    try {
      await this.deadlines.exit.run(async () => await this.childExited);
    } catch (cause) {
      throw new CsnapsProcessError(`csnaps process did not close after ${trigger}`, { cause });
    }
  }

  private async request(operation: CsnapsOperation, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.deadlineFor(operation.method).run(async (deadlineSignal) => await this.sendAndAwait(operation, deadlineSignal), signal);
    } catch (error) {
      // Once the helper failed terminally, that failure is the answer to everything.
      throw this.terminalError ?? error;
    }
  }

  private async sendAndAwait(operation: CsnapsOperation, deadlineSignal: AbortSignal): Promise<unknown> {
    if (this.terminalError != null) throw this.terminalError;
    const id = this.nextRequestId++;
    const answer = Promise.withResolvers<unknown>();
    const onDeadline = (): void => {
      if (!this.awaitingAnswer.delete(id)) return;
      const timedOut = deadlineSignal.reason instanceof Error && deadlineSignal.reason.name === "DeadlineExceededError";
      const error = new CsnapsProcessError(`csnaps ${operation.method} request ${timedOut ? "timed out" : "cancelled"}`, { cause: deadlineSignal.reason });
      answer.reject(error);
      this.fail(error);
    };
    this.awaitingAnswer.set(id, { method: operation.method, resolve: answer.resolve, reject: answer.reject, deadlineSignal, onDeadline });
    deadlineSignal.addEventListener("abort", onDeadline, { once: true });
    if (deadlineSignal.aborted) {
      onDeadline();
    } else {
      try {
        await writeFrame(this.child.stdin, encodeCsnapsRequest(id, operation));
      } catch (error) {
        const failure = this.terminalError ?? (error instanceof Error ? error : new CsnapsProcessError("csnaps stdin write failed", { cause: error }));
        this.fail(failure);
        throw failure;
      }
    }
    return await answer.promise;
  }

  private deadlineFor(method: CsnapsOperation["method"]): DeadlinePolicy {
    switch (method) {
      case "ping":
        return this.deadlines.ping;
      case "initialize":
        return this.deadlines.initialize;
      case "apply_codebase_specs":
        return this.deadlines.applyCodebaseSpecs;
      case "snapshot":
        return this.deadlines.snapshot;
      case "trigger_upload":
        return this.deadlines.triggerUpload;
      case "flush_pending_uploads":
        return this.deadlines.flushPendingUploads;
      case "shutdown":
        return this.deadlines.shutdown;
    }
  }

  /** Answers are checked as a whole read before any of them is handed over: a doubled answer is nobody's answer. */
  private handleAnswers(chunk: Buffer): void {
    if (this.terminalError != null) return;
    try {
      const answers = this.answers.decode(chunk);
      const seen = new Set<number>();
      for (const answer of answers) {
        if (seen.has(answer.id)) throw new CsnapsProcessError("csnaps returned a duplicate request ID");
        if (!this.awaitingAnswer.has(answer.id)) throw new CsnapsProcessError("csnaps returned an unknown request ID");
        seen.add(answer.id);
      }
      for (const answer of answers) this.settle(answer);
    } catch (error) {
      this.fail(error instanceof Error ? error : new CsnapsProcessError("invalid csnaps response", { cause: error }));
    }
  }

  private settle(answer: CsnapsResponse): void {
    const awaiting = this.awaitingAnswer.get(answer.id);
    if (awaiting == null) throw new CsnapsProcessError("csnaps returned an unknown request ID");
    this.awaitingAnswer.delete(answer.id);
    awaiting.deadlineSignal.removeEventListener("abort", awaiting.onDeadline);
    if (answer.ok) awaiting.resolve(answer.result);
    else awaiting.reject(new CsnapsRequestError(awaiting.method, answer.error));
  }

  private fail(error: Error): void {
    if (this.terminalError != null) return;
    this.terminalError = error;
    this.child.stdin.destroy();
    this.child.kill("SIGTERM");
    this.rejectAllAwaiting(error);
    if (!this.isClosing) this.resolveTerminalFailure(error);
  }

  private rejectAllAwaiting(error: Error): void {
    for (const awaiting of this.awaitingAnswer.values()) {
      awaiting.deadlineSignal.removeEventListener("abort", awaiting.onDeadline);
      awaiting.reject(error);
    }
    this.awaitingAnswer.clear();
  }
}

export function spawnCsnaps(options: CsnapsSpawnOptions) {
  return CsnapsProcess.spawn(options);
}

export function describeCsnapsExit(exitCode: number | null, signal: NodeJS.Signals | null): string {
  if (exitCode != null) return `csnaps process exited with code ${exitCode}`;
  if (signal != null) return `csnaps process exited due to signal ${signal}`;
  return "csnaps process exited";
}

export function writeFrame(stream: Writable, frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      stream.write(frame, (error) => (error == null ? resolve() : reject(new CsnapsProcessError(`csnaps stdin write failed: ${error.message}`, { cause: error }))));
    } catch (cause) {
      reject(new CsnapsProcessError(`csnaps stdin write failed${cause instanceof Error ? `: ${cause.message}` : ""}`, { cause }));
    }
  });
}
