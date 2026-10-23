/**
 * Watching the shells that keep running, and telling someone about them.
 *
 * A background shell writes output long after the turn that started it, and the user has to hear about it without being
 * flooded: what it writes is scanned for the patterns the caller asked to be told about, the notifications are
 * debounced and carried over between reads so a match that straddles two reads is still seen, and the text that is sent
 * is cut to what a notification can hold. The same factory wraps a shell so its output is logged to a file as it comes,
 * which is what makes a shell that has been running for hours readable afterwards.
 */
import { Buffer } from "node:buffer";
import { promises as fs } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RE2JS } from "re2js";

import { LEGACY_LOCAL_WAKEUP_CONVERSATION_ID } from "../agent-exec/background-work-registry.ts";
import {
  type BackgroundAdoptState,
  type BackgroundSpawnContext,
  type BackgroundShell,
  type BackgroundShellFactory,
  type BackgroundWorkRegistry,
} from "./background-shell-lifecycle.ts";
import type { ShellCoreEvent } from "./shell-core.ts";
import { type Context } from "../context/context.ts";
import { createLogger } from "../context/logging.ts";

const logger = createLogger("local-exec:background-shell");
const OUTPUT_NOTIFICATION_LIMIT = 100;
const OUTPUT_NOTIFICATION_MIN_DEBOUNCE_MS = 5_000;
const OUTPUT_NOTIFICATION_DEBOUNCE_MS = OUTPUT_NOTIFICATION_MIN_DEBOUNCE_MS;
const OUTPUT_NOTIFICATION_CARRYOVER_CHARS = 1_024;
const MAX_NOTIFICATION_TEXT_CHARS = 500;
const MAX_OUTPUT_NOTIFICATION_MATCHED_TEXT_CHARS = 5_000;
const MAX_OUTPUT_NOTIFICATION_PATTERN_CHARS = 500;
const MAX_OUTPUT_NOTIFICATION_SCAN_CHARS = 64 * 1024;
const RUNNING_TIME_UPDATE_INTERVAL_MS = 5_000;
const RUNNING_MS_WIDTH = 9;
const TERMINAL_TASK_STATUS_WIDTH = 9;

interface OutputNotificationConfig {
  readonly pattern: string;
  readonly reason: string;
  readonly notificationLimit?: number | undefined;
  readonly debounce?: number | undefined;
}

interface NotificationArguments {
  readonly shellId: number;
  readonly outputPath: string;
  readonly config: OutputNotificationConfig;
  readonly conversationId: string;
  readonly toolCallId?: string | undefined;
  readonly debounceMs?: number | undefined;
  readonly registry: Pick<BackgroundWorkRegistry, "enqueue">;
}

type ShellEvent = ShellCoreEvent;

interface ShellArguments {
  readonly signal?: AbortSignal | undefined;
  readonly showElapsedTime?: boolean | undefined;
}

interface ShellExecutionContext {
  readonly ctx?: Context | undefined;
  readonly shellId: number;
  readonly conversationId?: string | undefined;
  readonly toolCallId?: string | undefined;
  readonly outputNotification?: unknown;
  readonly command: string;
  readonly workingDirectory: string;
  readonly description?: string | undefined;
}

interface LoggingExecutionContext extends ShellExecutionContext {
  readonly shellId: number;
}

interface CoreExecutor {
  execute(ctx: unknown, args: ShellArguments): AsyncIterable<ShellEvent>;
}

interface EventIterator {
  next(): Promise<IteratorResult<ShellEvent>>;
  return?(value?: unknown): Promise<IteratorResult<ShellEvent>>;
}

interface LoggedStdin {
  write(...args: unknown[]): unknown;
  end(...args: unknown[]): unknown;
}

/** One notification the watcher queues, before it is handed to the registry. */
interface NotificationBatch {
  startOccurrence: number;
  endOccurrence: number;
  count: number;
  matchedTextDetail?: string;
}

/** Where a terminal's frontmatter and footer go, and how long the shell has been running. */
interface TerminalSummary {
  readonly pid?: number | undefined;
  readonly cwd: string;
  readonly command: string;
  readonly title?: string | undefined;
  readonly status: string;
  readonly startedAt: string;
  readonly runningForMs: number;
}

function isOutputNotificationConfig(value: unknown): value is OutputNotificationConfig {
  return typeof value === "object" && value !== null && "pattern" in value && typeof value.pattern === "string" && "reason" in value && typeof value.reason === "string";
}

function getConfiguredOutputNotificationDebounceMs(config: OutputNotificationConfig): number | undefined {
  const debounceSeconds = config.debounce;
  if (debounceSeconds === undefined || !Number.isFinite(debounceSeconds)) return undefined;
  return Math.ceil(debounceSeconds * 1_000);
}

function truncateNotificationText(value: string): string {
  return value.length <= MAX_NOTIFICATION_TEXT_CHARS ? value : `${value.slice(0, MAX_NOTIFICATION_TEXT_CHARS)}...`;
}

function formatMatchedTextDetail(matchText: string, label: string): string {
  return matchText.length <= MAX_OUTPUT_NOTIFICATION_MATCHED_TEXT_CHARS
    ? `${label}: ${matchText}`
    : `${label} is ${matchText.length} characters; omitted from notification detail.`;
}

/** The registry payload one progress notification carries, whatever it is about. */
function taskProgressPayload(args: {
  readonly taskId: string;
  readonly toolCallId: string | undefined;
  readonly title: string;
  readonly detail: string;
  readonly outputPath: string;
}) {
  return {
    taskId: args.taskId,
    ...(args.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }),
    kind: "shell",
    status: "success",
    title: args.title,
    detail: args.detail,
    outputPath: args.outputPath,
    reason: "task_progress",
  };
}

/** The sentence a notification adds about the text that matched, when it kept any. */
function matchedTextSentence(batch: NotificationBatch): string {
  return batch.matchedTextDetail !== undefined ? ` ${batch.matchedTextDetail}.` : "";
}

/** The detail of a notification for one occurrence or a batch of them. */
function occurrenceDetail(pattern: string, batch: NotificationBatch): string {
  if (batch.count === 1) {
    return `Shell output has pattern /${pattern}/. This is occurrence number ${batch.startOccurrence}.${matchedTextSentence(batch)} The title message is being displayed to the user.`;
  }
  return `Shell output matched /${pattern}/ ${batch.count} more times since the previous notification. The title message is being displayed to the user.${matchedTextSentence(batch)}`;
}

/** Runs a matcher over a growing window, keeping what straddles two reads. */
function matchNewOccurrences(
  regex: RE2JS,
  text: string,
  before: number,
  onMatch: (matchText: string) => void,
): void {
  const matcher = regex.matcher(text);
  while (matcher.find()) {
    const matchText = matcher.group() ?? "";
    if (matcher.end() > before) onMatch(matchText);
  }
}

export class ShellOutputNotificationObserver {
  private readonly args: NotificationArguments;
  private window = "";
  private occurrences = 0;
  private sentNotifications = 0;
  private finished = false;
  private readonly limit: number;
  private readonly regex: RE2JS;
  private pending: NotificationBatch | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(args: NotificationArguments) {
    this.args = args;
    this.limit = args.config.notificationLimit ?? OUTPUT_NOTIFICATION_LIMIT;
    if (args.config.pattern.length > MAX_OUTPUT_NOTIFICATION_PATTERN_CHARS) {
      throw new Error(`Output notification pattern exceeds ${MAX_OUTPUT_NOTIFICATION_PATTERN_CHARS} characters`);
    }
    this.regex = RE2JS.compile(args.config.pattern, RE2JS.MULTILINE);
  }

  observe(data: string): void {
    if (this.finished || this.occurrences >= this.limit || data.length === 0) return;
    // A very large read is scanned in windows, so no single scan walks more than the configured amount.
    if (data.length > MAX_OUTPUT_NOTIFICATION_SCAN_CHARS) {
      for (let offset = 0; offset < data.length && this.occurrences < this.limit; offset += MAX_OUTPUT_NOTIFICATION_SCAN_CHARS) {
        this.observe(data.slice(offset, offset + MAX_OUTPUT_NOTIFICATION_SCAN_CHARS));
      }
      return;
    }
    const before = this.window.length;
    this.window += data;
    matchNewOccurrences(this.regex, this.window, before, (matchText) => this.queueMatch(matchText));
    this.window = this.window.slice(-OUTPUT_NOTIFICATION_CARRYOVER_CHARS);
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.flushPendingBatch();
    this.clearFlushTimer();
  }

  private queueMatch(matchText: string): void {
    if (this.occurrences >= this.limit) return;
    this.occurrences += 1;
    const occurrence = this.occurrences;
    const matchedTextDetail = formatMatchedTextDetail(matchText, occurrence === 1 ? "Matched text" : "Latest match");
    // The first occurrence goes out at once; the rest wait for the debounce, so a busy shell is not a flood.
    if (occurrence === 1) {
      this.emitNotification({ startOccurrence: occurrence, endOccurrence: occurrence, count: 1, matchedTextDetail });
      if (occurrence === this.limit) this.emitLimitReachedNotification();
      return;
    }
    if (this.pending == null) {
      this.pending = { startOccurrence: occurrence, endOccurrence: occurrence, count: 1, matchedTextDetail };
    } else {
      this.pending.endOccurrence = occurrence;
      this.pending.count += 1;
      this.pending.matchedTextDetail = matchedTextDetail;
    }
    if (occurrence === this.limit) {
      this.flushPendingBatch();
      this.emitLimitReachedNotification();
      return;
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => this.flushPendingBatch(), this.getDebounceMs());
  }

  private getDebounceMs(): number {
    const debounceMs = this.args.debounceMs ?? getConfiguredOutputNotificationDebounceMs(this.args.config) ?? OUTPUT_NOTIFICATION_DEBOUNCE_MS;
    return Math.max(debounceMs, OUTPUT_NOTIFICATION_MIN_DEBOUNCE_MS);
  }

  private clearFlushTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private flushPendingBatch(): void {
    const batch = this.pending;
    if (batch == null) return;
    this.pending = undefined;
    this.clearFlushTimer();
    this.emitNotification(batch);
  }

  private notificationTitle(): string {
    return this.args.config.reason.trim() || `Shell output contains /${this.args.config.pattern}/`;
  }

  private taskProgressId(): string {
    return `${this.args.shellId}:task_progress:${this.sentNotifications}`;
  }

  private enqueueProgress(title: string, detail: string): void {
    this.sentNotifications += 1;
    const taskId = this.taskProgressId();
    this.args.registry.enqueue({
      conversationId: this.args.conversationId,
      id: taskId,
      source: "shell",
      payload: taskProgressPayload({
        taskId,
        toolCallId: this.args.toolCallId,
        title,
        detail,
        outputPath: this.args.outputPath,
      }),
    });
  }

  private emitNotification(batch: NotificationBatch): void {
    this.enqueueProgress(truncateNotificationText(this.notificationTitle()), occurrenceDetail(this.args.config.pattern, batch));
  }

  private emitLimitReachedNotification(): void {
    this.enqueueProgress(
      `Notification limit reached (${this.limit})`,
      `Shell output matched /${this.args.config.pattern}/ ${this.limit} times and has reached the notification limit. No further notifications will be sent for this pattern. To continue monitoring, read the output file directly at the output path.`,
    );
  }
}

export class NotifyingBackgroundShellFactory {
  constructor(
    private readonly innerFactory: BackgroundShellFactory,
    private readonly projectDir: string,
    private readonly backgroundWorkRegistry?: BackgroundWorkRegistry,
  ) {}

  async spawn(executionContext: BackgroundSpawnContext, coreExecutor: unknown): Promise<BackgroundShell> {
    const context: ShellExecutionContext = executionContext;
    const watcher = this.createObserver(context.ctx, context.shellId, context.conversationId, context.toolCallId, context.outputNotification);
    if (watcher == null) return this.innerFactory.spawn(executionContext, coreExecutor);
    try {
      return await this.innerFactory.spawn(executionContext, this.createObservingExecutor(coreExecutor as CoreExecutor, watcher));
    } catch (error) {
      watcher.finish();
      throw error;
    }
  }

  async adopt(state: BackgroundAdoptState): Promise<BackgroundShell> {
    const value: ShellExecutionContext & { readonly initialOutput: string; readonly eventIterator: EventIterator } = state;
    const watcher = this.createObserver(value.ctx, value.shellId, undefined, value.toolCallId, value.outputNotification);
    if (watcher == null) return this.innerFactory.adopt(state);
    if (value.initialOutput.length > 0) watcher.observe(value.initialOutput);
    try {
      return await this.innerFactory.adopt({ ...state, eventIterator: this.createObservingIterator(value.eventIterator, watcher) });
    } catch (error) {
      watcher.finish();
      throw error;
    }
  }

  private createObserver(
    ctx: Context | undefined,
    shellId: number,
    conversationId: string | undefined,
    toolCallId: string | undefined,
    config: unknown,
  ): ShellOutputNotificationObserver | undefined {
    if (this.backgroundWorkRegistry == null || !isOutputNotificationConfig(config) || config.pattern.trim().length === 0) return undefined;
    const outputPath = join(this.projectDir, "terminals", `${shellId}.txt`);
    try {
      return new ShellOutputNotificationObserver({
        shellId,
        outputPath,
        config,
        conversationId: conversationId ?? LEGACY_LOCAL_WAKEUP_CONVERSATION_ID,
        toolCallId,
        registry: this.backgroundWorkRegistry,
      });
    } catch (error) {
      if (ctx !== undefined) logger.warn(ctx, "Invalid shell output notification pattern", { shellId, error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  private createObservingExecutor(coreExecutor: CoreExecutor, watcher: ShellOutputNotificationObserver): CoreExecutor {
    const originalExecute = coreExecutor.execute.bind(coreExecutor);
    return {
      ...coreExecutor,
      execute: async function* (ctx: unknown, args: ShellArguments): AsyncIterable<ShellEvent> {
        try {
          for await (const event of originalExecute(ctx, args)) {
            observeShellEvent(watcher, event);
            yield event;
          }
        } finally {
          watcher.finish();
        }
      },
    };
  }

  private createObservingIterator(iterator: EventIterator, watcher: ShellOutputNotificationObserver): EventIterator {
    const returnIterator = iterator.return?.bind(iterator);
    return {
      next: async () => {
        try {
          const result = await iterator.next();
          if (!result.done) observeShellEvent(watcher, result.value);
          else watcher.finish();
          return result;
        } catch (error) {
          watcher.finish();
          throw error;
        }
      },
      return: async (value?: unknown) => {
        watcher.finish();
        return returnIterator ? returnIterator(value) : { done: true, value: undefined };
      },
    };
  }
}

/** Feeds one shell event to the watcher: output is scanned, an exit ends the watching. */
function observeShellEvent(watcher: ShellOutputNotificationObserver, event: ShellEvent): void {
  if (event.type === "stdout" || event.type === "stderr") watcher.observe(event.data ?? "");
  else if (event.type === "exit") watcher.finish();
}

function escapeYamlString(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function buildFrontmatter(params: TerminalSummary): string {
  const paddedMs = String(params.runningForMs).padEnd(RUNNING_MS_WIDTH, " ");
  const paddedStatus = params.status.padEnd(TERMINAL_TASK_STATUS_WIDTH, " ");
  let content = "---\n";
  if (params.pid !== undefined && params.pid !== 0) content += `pid: ${params.pid}\n`;
  content += `cwd: ${escapeYamlString(params.cwd)}\n`;
  content += `command: ${escapeYamlString(params.command)}\n`;
  if (params.title !== undefined && params.title.trim().length > 0) content += `title: ${escapeYamlString(params.title)}\n`;
  content += `status: ${paddedStatus}\n`;
  content += `started_at: ${params.startedAt}\n`;
  content += `running_for_ms: ${paddedMs}\n`;
  return `${content}---\n`;
}

/** The footer written when a shell stops, naming how it ended and when. */
function buildFooter(firstFooterLine: string, showElapsedTime: boolean | undefined, startTime: number): string {
  return `\n---\n${firstFooterLine}\n${showElapsedTime ? `elapsed_ms: ${Date.now() - startTime}\n` : ""}ended_at: ${new Date().toISOString()}\n---\n`;
}

/** Logs everything written to a shell's stdin to the terminal file, keeping the stream's own behaviour. */
function patchStdinLogging(stdin: LoggedStdin, appendQuietly: (data: string) => Promise<void>): void {
  const logInputChunk = (chunk: unknown): void => {
    if (chunk === undefined || chunk === null) return;
    const chunkString = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    if (chunkString.length === 0) return;
    void appendQuietly(`[stdin] ${chunkString.endsWith("\n") ? chunkString : `${chunkString}\n`}`);
  };
  const stream = stdin as unknown as {
    write: (chunk: Uint8Array | string, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => boolean;
    end: (chunkOrCallback?: Uint8Array | string | (() => void), encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void) => NodeJS.WritableStream;
  };
  const originalWrite = stream.write.bind(stream);
  stream.write = (chunk: Uint8Array | string, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
    logInputChunk(chunk);
    return Reflect.apply(originalWrite, stdin, typeof encodingOrCallback === "function" ? [chunk, encodingOrCallback] : [chunk, encodingOrCallback, callback]);
  };
  const originalEnd = stream.end;
  stream.end = (chunkOrCallback?: Uint8Array | string | (() => void), encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void): NodeJS.WritableStream => {
    if (typeof chunkOrCallback !== "function" && chunkOrCallback !== undefined) logInputChunk(chunkOrCallback);
    return Reflect.apply(originalEnd, stdin, typeof chunkOrCallback === "function"
      ? [chunkOrCallback]
      : typeof encodingOrCallback === "function"
        ? chunkOrCallback === undefined ? [encodingOrCallback] : [chunkOrCallback, encodingOrCallback]
        : chunkOrCallback === undefined ? [callback] : [chunkOrCallback, encodingOrCallback, callback]);
  };
}

export class FileLoggingShellFactory {
  constructor(private readonly innerFactory: BackgroundShellFactory, private readonly projectDir: string) {}

  async spawn(executionContext: BackgroundSpawnContext, coreExecutor: unknown): Promise<BackgroundShell> {
    const terminalsDir = join(this.projectDir, "terminals");
    await mkdir(terminalsDir, { recursive: true });
    return this.innerFactory.spawn(executionContext, this.createLoggingExecutor(coreExecutor as CoreExecutor, executionContext as unknown as LoggingExecutionContext, terminalsDir));
  }

  private createLoggingExecutor(coreExecutor: CoreExecutor, executionContext: LoggingExecutionContext, terminalsDir: string): CoreExecutor {
    const originalExecute = coreExecutor.execute.bind(coreExecutor);
    return {
      ...coreExecutor,
      execute: async function* (ctx: unknown, args: ShellArguments): AsyncIterable<ShellEvent> {
        let metaHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
        let logHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
        let stdinPatched = false;
        let headerDone = false;
        let ticker: ReturnType<typeof setInterval> | undefined;
        const startTime = Date.now();
        const startedAt = new Date(startTime).toISOString();
        let currentPid: number | undefined;
        let taskStatus = "running";
        let finished = false;
        let pendingMeta: Promise<void> = Promise.resolve();
        const shellId = executionContext.shellId;
        const logPath = join(terminalsDir, `${shellId}.txt`);
        const summary = (): TerminalSummary => ({
          pid: currentPid,
          cwd: executionContext.workingDirectory,
          command: executionContext.command,
          title: executionContext.description,
          status: taskStatus,
          startedAt,
          runningForMs: Date.now() - startTime,
        });
        const appendQuietly = async (data: string): Promise<void> => {
          if (logHandle == null) return;
          try { await logHandle.write(data); } catch {}
        };
        const writeMeta = async (): Promise<void> => {
          if (metaHandle == null) return;
          try { await metaHandle.write(buildFrontmatter(summary()), 0, "utf8"); } catch {}
        };
        const queueMeta = (): Promise<void> => {
          pendingMeta = pendingMeta.then(writeMeta).catch(() => {});
          return pendingMeta;
        };
        const stopTicker = (): void => {
          if (ticker === undefined) return;
          clearInterval(ticker);
          ticker = undefined;
        };
        const ensureOpen = async (): Promise<void> => {
          if (metaHandle == null) metaHandle = await fs.open(logPath, "r+");
          if (logHandle == null) logHandle = await fs.open(logPath, "a");
        };
        const writeHeaderLine = async (pid?: number): Promise<void> => {
          if (headerDone) return;
          headerDone = true;
          currentPid = pid;
          await writeFile(logPath, buildFrontmatter(summary()), "utf8");
          ticker = setInterval(() => { void queueMeta(); }, RUNNING_TIME_UPDATE_INTERVAL_MS);
        };
        const finishTerminal = async (status: string, firstFooterLine?: string): Promise<void> => {
          if (finished) return;
          finished = true;
          stopTicker();
          if (!headerDone) await writeHeaderLine();
          await ensureOpen();
          if (firstFooterLine !== undefined) await appendQuietly(buildFooter(firstFooterLine, args.showElapsedTime, startTime));
          taskStatus = status;
          await queueMeta();
        };
        try {
          for await (const event of originalExecute(ctx, args)) {
            if (event.type === "stdout" || event.type === "stderr") {
              if (!headerDone) { await writeHeaderLine(); await ensureOpen(); }
              await appendQuietly(event.data ?? "");
            } else if (event.type === "stdin_ready" && !stdinPatched) {
              stdinPatched = true;
              if (!headerDone) { await writeHeaderLine(event.pid); await ensureOpen(); }
              if (event.stdin) patchStdinLogging(event.stdin as LoggedStdin, appendQuietly);
            } else if (event.type === "exit") {
              await finishTerminal(event.aborted ? "aborted" : event.code === 0 ? "succeeded" : "failed", `exit_code: ${event.code ?? "unknown"}`);
            }
            yield event;
          }
          if (!finished) await finishTerminal(args.signal?.aborted ? "aborted" : "failed");
        } catch (error) {
          const aborted = args.signal?.aborted ?? false;
          await finishTerminal(aborted ? "aborted" : "failed", aborted ? undefined : `error: ${escapeYamlString(error instanceof Error ? error.message : "Unknown error")}`);
          if (!aborted) throw error;
        } finally {
          stopTicker();
          await pendingMeta;
          try { await metaHandle?.close(); } catch {}
          try { await logHandle?.close(); } catch {}
        }
      },
    };
  }

  async adopt(state: BackgroundAdoptState): Promise<BackgroundShell> {
    const value = state as unknown as LoggingExecutionContext & { readonly initialOutput?: string; readonly eventIterator: EventIterator; readonly startTime: number; readonly pid?: number; readonly showElapsedTime?: boolean; readonly abortController: AbortController };
    const terminalsDir = join(this.projectDir, "terminals");
    await mkdir(terminalsDir, { recursive: true });
    const logPath = join(terminalsDir, `${value.shellId}.txt`);
    const startTime = value.startTime;
    const startedAt = new Date(startTime).toISOString();
    let taskStatus = "running";
    const summary = (): TerminalSummary => ({
      pid: value.pid,
      cwd: value.workingDirectory,
      command: value.command,
      title: value.description,
      status: taskStatus,
      startedAt,
      runningForMs: Date.now() - startTime,
    });
    await writeFile(logPath, buildFrontmatter(summary()) + (value.initialOutput ?? ""), "utf8");
    const metaHandle = await fs.open(logPath, "r+");
    let logHandle: Awaited<ReturnType<typeof fs.open>>;
    try { logHandle = await fs.open(logPath, "a"); } catch (error) { await metaHandle.close(); throw error; }
    let cleanedUp = false;
    let finished = false;
    let pendingMeta: Promise<void> = Promise.resolve();
    const stopTicker = (): void => clearInterval(ticker);
    let ticker = setInterval(() => { void queueMeta(); }, RUNNING_TIME_UPDATE_INTERVAL_MS);
    const writeMeta = async (): Promise<void> => {
      try { await metaHandle.write(buildFrontmatter(summary()), 0, "utf8"); } catch {}
    };
    const queueMeta = (): Promise<void> => { pendingMeta = pendingMeta.then(writeMeta).catch(() => {}); return pendingMeta; };
    const cleanup = async (): Promise<void> => { if (cleanedUp) return; cleanedUp = true; stopTicker(); await pendingMeta; try { await metaHandle.close(); } catch {} try { await logHandle.close(); } catch {} };
    const appendQuietly = async (data: string): Promise<void> => { try { await logHandle.write(data); } catch {} };
    const finishTerminal = async (status: string, firstFooterLine?: string): Promise<void> => {
      if (finished) return;
      finished = true;
      stopTicker();
      if (firstFooterLine !== undefined) await appendQuietly(buildFooter(firstFooterLine, value.showElapsedTime, startTime));
      taskStatus = status;
      await queueMeta();
    };
    const loggingIterator: EventIterator = {
      next: async () => {
        try {
          const result = await value.eventIterator.next();
          if (!result.done) {
            if (result.value.type === "stdout" || result.value.type === "stderr") await appendQuietly(result.value.data ?? "");
            else if (result.value.type === "exit") {
              await finishTerminal(result.value.aborted ? "aborted" : result.value.code === 0 ? "succeeded" : "failed", `exit_code: ${result.value.code ?? "unknown"}`);
              await cleanup();
            }
          } else if (!finished) await finishTerminal(value.abortController.signal.aborted ? "aborted" : "failed");
          if (result.done) await cleanup();
          return result;
        } catch (error) {
          await finishTerminal(value.abortController.signal.aborted ? "aborted" : "failed");
          await cleanup();
          throw error;
        }
      },
      return: async () => {
        if (!finished) await finishTerminal(value.abortController.signal.aborted ? "aborted" : "failed");
        await cleanup();
        return value.eventIterator.return ? value.eventIterator.return() : { done: true, value: undefined };
      },
    };
    return this.innerFactory.adopt({ ...state, eventIterator: loggingIterator });
  }
}
