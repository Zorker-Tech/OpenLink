/**
 * The machine's own execution, offered as a provider.
 *
 * The provider keeps the gateway connection alive, routes each request to the machine's local tools, and returns results
 * through a bounded queue. A machine that cannot be reached says so rather than answering with an empty result.
 */
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "@bufbuild/protobuf";

import {
  createDeadlinePolicy,
  createIdleWatchdogPolicy,
  createPollingPolicy,
  createRetryPolicy,
  realClock,
} from "../extensions/scheduling.ts";
import { errorLogTag, errorMessage } from "../../shared/errors/summary.ts";
import { GATEWAY_AUTH_SCHEME } from "../../shared/gateway-wire.ts";
import {
  DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES,
  GATEWAY_LOCAL_EXEC_REQUESTS_PATH,
  GATEWAY_LOCAL_EXEC_RESPONSES_PATH,
  SLATE_LOCAL_EXEC_CONTROL_POST_TIMEOUT_MS,
  SLATE_LOCAL_EXEC_DATA_POST_TIMEOUT_MS,
  SLATE_LOCAL_EXEC_HEARTBEAT_INTERVAL_MS,
  localExecFileTooLargeMessage,
  localExecUploadFrameTooLargeMessage,
  maxLocalExecUploadFrameBytes,
} from "../../shared/local-exec-gateway.ts";
import { describeLocalExec, type LocalExecMessage, type SlateLocalToolRequest } from "../../shared/local-tool-permission-machinery.ts";
import { writeFileAtomic } from "../../shared/node/atomic-write.ts";
import { containPath, regularFileSizeBytes, resolveLocalExecRoot } from "./local-exec-machine.ts";
import type { LocalExecConnection } from "./local-exec-daemon-protocol.ts";

export class SlateLocalExecStreamError extends Error {}

export const SSE_RECONNECT_MIN_MS = 1_000;
export const SSE_RECONNECT_MAX_MS = 10_000;
export const SSE_STALL_TIMEOUT_MS = 35_000;
export const STALE_CONNECTION_FAILURE_THRESHOLD = 3;
export const RESPONSE_POST_RETRIES = 3;
export const RESPONSE_POST_RETRY_DELAY_MS = 200;
export const DEFAULT_SLATE_COMPUTER_ID = "this-computer";

export interface LocalExecDecodedMessage {
  id: number;
  readonly message?: { readonly case?: string; readonly value?: Record<string, unknown> };
}

export interface LocalExecExecutorOutput {
  readonly kind: "client" | "control";
  readonly message: JsonValue;
}

export interface LocalExecExecutor {
  decodeServerMessage(json: JsonValue): LocalExecDecodedMessage;
  execute(message: LocalExecDecodedMessage, signal: AbortSignal): AsyncIterable<LocalExecExecutorOutput>;
  cancel(execId: number): void;
  throwControl(error: string): JsonValue;
}

function isPlainMessage(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function descriptionMessage(decoded: LocalExecDecodedMessage): { readonly message: LocalExecMessage } | undefined {
  const message = decoded.message;
  if (typeof message?.case !== "string" || !isPlainMessage(message.value)) return undefined;
  return { message: { case: message.case, value: message.value } };
}

export type LocalExecRequestFrame =
  | { readonly kind: "welcome"; readonly providerId: string }
  | { readonly kind: "retire-approval"; readonly approvalId: string }
  | { readonly kind: "exec"; readonly requestId: string; readonly approvalId?: string; readonly serverMessage: JsonValue }
  | { readonly kind: "upload"; readonly requestId: string; readonly approvalId?: string; readonly path: string; readonly bytesBase64: string }
  | { readonly kind: "download"; readonly requestId: string; readonly approvalId?: string; readonly path: string }
  | { readonly kind: "cancel"; readonly requestId: string };

export type LocalExecResponseFrame =
  | { readonly kind: "hello"; readonly localRoot: string; readonly terminalsFolder: string; readonly computerId: string; readonly label: string; readonly supervised?: boolean; readonly variant?: string }
  | { readonly kind: "ping"; readonly supervised?: boolean }
  | { readonly kind: "client" | "control"; readonly requestId: string; readonly message: JsonValue }
  | { readonly kind: "file"; readonly requestId: string; readonly bytesBase64?: string }
  | { readonly kind: "file-error"; readonly requestId: string; readonly error: string };

export interface SlateLocalExecProviderOptions {
  readonly resolveConnection: () => Promise<LocalExecConnection>;
  readonly executor: LocalExecExecutor;
  readonly root?: string;
  readonly computerId?: string;
  readonly computerLabel?: string;
  readonly maxFileBytes?: number;
  readonly variant?: string;
  readonly fetch?: typeof fetch;
  readonly onConnectionStale?: () => Promise<void> | void;
  readonly isSupervised?: () => Promise<boolean | undefined> | boolean | undefined;
  readonly onApprovalRetired?: (approvalId: string) => Promise<void> | void;
  readonly isLocalUseBlocked?: (request: {
    readonly approvalId?: string;
    readonly describes?: SlateLocalToolRequest;
    readonly terminalsFolder: string;
  }) => Promise<string | undefined> | string | undefined;
  readonly onInflightChange?: (count: number) => void;
}

function connectionHeaders(headers: Record<string, string>, connection: LocalExecConnection): Record<string, string> {
  const merged = { ...headers, ...connection.headers };
  if (connection.token != null && connection.token.length > 0) {
    merged.authorization = `${GATEWAY_AUTH_SCHEME} ${connection.token}`;
  }
  return merged;
}

export function withLocalExecAuth(headers: Record<string, string>, connection: LocalExecConnection): Record<string, string> {
  return connectionHeaders(headers, connection);
}

function serializedHeaders(headers: Readonly<Record<string, string>> | undefined): string {
  return JSON.stringify(headers ?? {});
}

export function isSameLocalExecConnection(a: LocalExecConnection, b: LocalExecConnection): boolean {
  return a.baseUrl === b.baseUrl
    && a.token === b.token
    && serializedHeaders(a.headers) === serializedHeaders(b.headers);
}

type DescribedRequest = Extract<LocalExecRequestFrame, { kind: "exec" | "upload" | "download" }>;
type ActiveExecution = { readonly execId: number; readonly controller: AbortController };

export class SlateLocalExecProvider {
  readonly root: string;
  readonly terminalsFolder: string;
  readonly computerId: string;
  readonly computerLabel: string;
  readonly maxFileBytes: number;
  readonly maxUploadFrameBytes: number;

  private readonly fetcher: typeof fetch;
  private readonly executions = new Map<string, ActiveExecution>();
  private readonly pendingResponses: LocalExecResponseFrame[] = [];
  private readonly dataPostDeadline = createDeadlinePolicy(realClock, {
    name: "local-exec-data-post",
    timeoutMs: SLATE_LOCAL_EXEC_DATA_POST_TIMEOUT_MS,
  });
  private readonly controlPostDeadline = createDeadlinePolicy(realClock, {
    name: "local-exec-control-post",
    timeoutMs: SLATE_LOCAL_EXEC_CONTROL_POST_TIMEOUT_MS,
  });
  private readonly responseRetry = createRetryPolicy(realClock, {
    name: "local-exec-response-post",
    maxAttempts: RESPONSE_POST_RETRIES,
    initialDelayMs: RESPONSE_POST_RETRY_DELAY_MS,
    maxDelayMs: RESPONSE_POST_RETRY_DELAY_MS,
  });
  private readonly reconnectDelay = createRetryPolicy(realClock, {
    name: "local-exec-sse-reconnect",
    maxAttempts: Number.MAX_SAFE_INTEGER,
    initialDelayMs: SSE_RECONNECT_MIN_MS,
    maxDelayMs: SSE_RECONNECT_MAX_MS,
  });
  private readonly stallWatchdog = createIdleWatchdogPolicy(realClock, {
    name: "local-exec-sse-stall",
    idleMs: SSE_STALL_TIMEOUT_MS,
  });
  private readonly heartbeat = createPollingPolicy(realClock, {
    name: "local-exec-heartbeat",
    intervalMs: SLATE_LOCAL_EXEC_HEARTBEAT_INTERVAL_MS,
  });

  private stopping = false;
  private streamAbort?: AbortController;
  private nextExecutionId = 1;
  private sendingResponses = false;
  private activeProviderId: string | undefined;

  constructor(private readonly options: SlateLocalExecProviderOptions) {
    this.root = options.root ?? resolveLocalExecRoot();
    this.terminalsFolder = join(this.root, "terminals");

    const hostName = hostname().trim();
    this.computerId = options.computerId?.trim() || hostName || DEFAULT_SLATE_COMPUTER_ID;
    this.computerLabel = options.computerLabel?.trim() || hostName || "this computer";

    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES;
    this.maxUploadFrameBytes = maxLocalExecUploadFrameBytes(this.maxFileBytes);
    this.fetcher = options.fetch ?? fetch;
  }

  start(): void {
    void this.reconnectUntilClosed();
  }

  close(): void {
    this.stopping = true;
    this.streamAbort?.abort();
    for (const active of this.executions.values()) active.controller.abort();
  }

  private queueResponse(frame: LocalExecResponseFrame): void {
    this.pendingResponses.push(frame);
    void this.flushResponses();
  }

  private async postResponses(
    frames: readonly LocalExecResponseFrame[],
    deadline: ReturnType<typeof createDeadlinePolicy> = this.dataPostDeadline,
  ): Promise<boolean> {
    try {
      return await this.responseRetry.runWithRetry(async () => {
        const connection = await this.options.resolveConnection();
        const response = await deadline.run((signal) => this.fetcher(
          `${connection.baseUrl}${GATEWAY_LOCAL_EXEC_RESPONSES_PATH}`,
          {
            method: "POST",
            headers: connectionHeaders({ "content-type": "application/json" }, connection),
            body: JSON.stringify({ providerId: this.activeProviderId, frames }),
            signal,
          },
        ));
        if (!response.ok) {
          const failure = new Error("response POST failed") as Error & { code?: string };
          failure.code = `http_${response.status}`;
          throw failure;
        }
        return true;
      });
    } catch (error) {
      console.error(`[local-exec-provider] dropping ${frames.length}-frame response batch after ${RESPONSE_POST_RETRIES} failed POSTs: ${errorLogTag(error)}`);
      return false;
    }
  }

  private async flushResponses(): Promise<void> {
    if (this.sendingResponses) return;
    this.sendingResponses = true;

    try {
      while (this.pendingResponses.length > 0 && !this.stopping) {
        const batch = this.pendingResponses.slice();
        const delivered = await this.postResponses(batch);
        this.pendingResponses.splice(0, batch.length);
        if (!delivered) break;
      }
    } finally {
      this.sendingResponses = false;
    }
  }

  private async reconnectUntilClosed(): Promise<void> {
    let attempt = 1;
    let failedConnections = 0;

    while (!this.stopping) {
      try {
        await this.streamRequests(() => {
          attempt = 1;
          failedConnections = 0;
        });
      } catch {
        failedConnections += 1;
      }

      if (this.stopping) break;
      if (failedConnections >= STALE_CONNECTION_FAILURE_THRESHOLD && this.options.onConnectionStale != null) {
        failedConnections = 0;
        await this.refreshAfterRepeatedFailure();
      }

      const pause = this.reconnectDelay.schedule(attempt);
      try {
        await pause.elapsed;
      } finally {
        pause.dispose();
      }
      attempt += 1;
    }
  }

  private async refreshAfterRepeatedFailure(): Promise<void> {
    try {
      await this.options.onConnectionStale?.();
    } catch (error) {
      console.error(`[local-exec-provider] stale-connection re-resolve failed: ${errorLogTag(error)}`);
    }
  }

  private async dialedConnectionState(dialed: LocalExecConnection): Promise<"same" | "moved" | "unreadable"> {
    try {
      return isSameLocalExecConnection(await this.options.resolveConnection(), dialed) ? "same" : "moved";
    } catch {
      return "unreadable";
    }
  }

  private async supervisionStatus(): Promise<boolean | undefined> {
    return await this.options.isSupervised?.();
  }

  private announceProvider(): void {
    void this.supervisionStatus().then((supervised) => this.postResponses([{
      kind: "hello",
      localRoot: this.root,
      terminalsFolder: this.terminalsFolder,
      computerId: this.computerId,
      label: this.computerLabel,
      ...(supervised === undefined ? {} : { supervised }),
      ...(this.options.variant === undefined ? {} : { variant: this.options.variant }),
    }], this.controlPostDeadline));
  }

  private startConnectionHeartbeat(connection: LocalExecConnection, controller: AbortController) {
    return this.heartbeat.start(async () => {
      const supervised = await this.supervisionStatus();
      void this.postResponses([{ kind: "ping", ...(supervised === undefined ? {} : { supervised }) }], this.controlPostDeadline);
      if (await this.dialedConnectionState(connection) === "moved") controller.abort();
    });
  }

  async streamRequests(resetBackoff: () => void = () => {}): Promise<void> {
    const connection = await this.options.resolveConnection();
    const controller = new AbortController();
    this.streamAbort = controller;

    const response = await this.fetcher(
      `${connection.baseUrl}${GATEWAY_LOCAL_EXEC_REQUESTS_PATH}`,
      {
        headers: connectionHeaders({ accept: "text/event-stream" }, connection),
        signal: controller.signal,
      },
    );
    if (!response.ok || response.body == null) {
      throw new SlateLocalExecStreamError(`local-exec requests stream failed: ${response.status}`);
    }

    resetBackoff();
    this.announceProvider();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const stall = this.stallWatchdog.arm(() => controller.abort());
    const heartbeat = this.startConnectionHeartbeat(connection, controller);

    try {
      await this.readServerEvents(reader, decoder, stall);
    } finally {
      stall.dispose();
      heartbeat.dispose();
      this.activeProviderId = undefined;
    }
  }

  private async readServerEvents(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: TextDecoder,
    stall: { kick(): void; dispose(): void },
  ): Promise<void> {
    let bufferedText = "";
    let skippingOversizedEvent = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;

      stall.kick();
      bufferedText += decoder.decode(value, { stream: true });
      if (skippingOversizedEvent) {
        const endOfEvent = bufferedText.indexOf("\n\n");
        if (endOfEvent < 0) {
          bufferedText = bufferedText.slice(-1);
          continue;
        }
        bufferedText = bufferedText.slice(endOfEvent + 2);
        skippingOversizedEvent = false;
      }

      let endOfEvent = bufferedText.indexOf("\n\n");
      while (endOfEvent >= 0) {
        const event = bufferedText.slice(0, endOfEvent);
        if (endOfEvent > this.maxUploadFrameBytes) this.rejectOversizedEvent(bufferedText);
        else this.dispatchEventBlock(event);
        bufferedText = bufferedText.slice(endOfEvent + 2);
        endOfEvent = bufferedText.indexOf("\n\n");
      }

      if (bufferedText.length > this.maxUploadFrameBytes) {
        this.rejectOversizedEvent(bufferedText);
        bufferedText = bufferedText.slice(-1);
        skippingOversizedEvent = true;
      }
    }
  }

  private rejectOversizedEvent(prefix: string): void {
    const requestId = /"requestId"\s*:\s*"([^"\\]+)"/.exec(prefix.slice(0, 4_096))?.[1];
    if (requestId != null) {
      this.queueResponse({
        kind: "file-error",
        requestId,
        error: localExecUploadFrameTooLargeMessage(this.maxFileBytes),
      });
    }
  }

  private dispatchEventBlock(block: string): void {
    const payload = block.split("\n").filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (payload.length === 0) return;

    try {
      void this.handleRequest(JSON.parse(payload.join("\n")) as LocalExecRequestFrame);
    } catch (error) {
      console.error(`[local-exec-provider] dropping unparseable request frame: ${errorLogTag(error)}`);
    }
  }

  async handleRequest(frame: LocalExecRequestFrame): Promise<void> {
    if (frame.kind === "retire-approval") {
      await this.options.onApprovalRetired?.(frame.approvalId);
      return;
    }

    if (isDescribedRequest(frame)) {
      const described = this.describeRequest(frame);
      const blocked = await this.options.isLocalUseBlocked?.({
        ...(frame.approvalId === undefined ? {} : { approvalId: frame.approvalId }),
        ...(described === undefined ? {} : { describes: described }),
        terminalsFolder: this.terminalsFolder,
      });
      if (blocked !== undefined) {
        this.refuseRequest(frame, blocked);
        return;
      }
    }

    switch (frame.kind) {
      case "welcome":
        this.activeProviderId = frame.providerId;
        return;
      case "exec":
        return this.executeRequest(frame.requestId, frame.serverMessage);
      case "upload":
        return this.writeIncomingFile(frame.requestId, frame.path, frame.bytesBase64);
      case "download":
        return this.readOutgoingFile(frame.requestId, frame.path);
      case "cancel":
        return this.cancelExecution(frame.requestId);
    }
  }

  private describeRequest(frame: DescribedRequest): SlateLocalToolRequest | undefined {
    if (frame.kind === "upload") return { action: "write-file", target: frame.path };
    if (frame.kind === "download") return { action: "read-file", target: frame.path, attachToResourcePath: frame.path };

    try {
      const decoded = this.options.executor.decodeServerMessage(frame.serverMessage);
      const normalized = descriptionMessage(decoded);
      return normalized === undefined ? undefined : describeLocalExec(normalized, this.terminalsFolder);
    } catch {
      return undefined;
    }
  }

  private refuseRequest(frame: DescribedRequest, reason: string): void {
    if (frame.kind === "exec") {
      this.queueResponse({ kind: "control", requestId: frame.requestId, message: this.options.executor.throwControl(reason) });
      return;
    }
    this.queueResponse({ kind: "file-error", requestId: frame.requestId, error: reason });
  }

  private async executeRequest(requestId: string, wireMessage: JsonValue): Promise<void> {
    let message: LocalExecDecodedMessage;
    try {
      message = this.options.executor.decodeServerMessage(wireMessage);
    } catch (error) {
      this.queueResponse({
        kind: "control",
        requestId,
        message: this.options.executor.throwControl(errorMessage(error)),
      });
      return;
    }

    const executionId = this.nextExecutionId++;
    message.id = executionId;
    const controller = new AbortController();
    this.executions.set(requestId, { execId: executionId, controller });
    this.options.onInflightChange?.(this.executions.size);

    try {
      for await (const output of this.options.executor.execute(message, controller.signal)) {
        this.queueResponse({ kind: output.kind, requestId, message: output.message });
      }
    } finally {
      this.executions.delete(requestId);
      this.options.onInflightChange?.(this.executions.size);
    }
  }

  private cancelExecution(requestId: string): void {
    const execution = this.executions.get(requestId);
    if (execution == null) return;
    this.options.executor.cancel(execution.execId);
    execution.controller.abort();
  }

  private async writeIncomingFile(requestId: string, path: string, bytesBase64: string): Promise<void> {
    const approximateSize = Math.floor(bytesBase64.length * 3 / 4);
    if (approximateSize > this.maxFileBytes) {
      this.queueResponse({
        kind: "file-error",
        requestId,
        error: localExecFileTooLargeMessage(approximateSize, this.maxFileBytes),
      });
      return;
    }

    try {
      const target = await containPath({ root: this.root, path });
      await writeFileAtomic(target, Buffer.from(bytesBase64, "base64"));
      this.queueResponse({ kind: "file", requestId });
    } catch (error) {
      this.queueResponse({ kind: "file-error", requestId, error: errorMessage(error) });
    }
  }

  private async readOutgoingFile(requestId: string, path: string): Promise<void> {
    try {
      const target = await containPath({ root: this.root, path });
      const size = await regularFileSizeBytes(target);
      if (size !== undefined && size > this.maxFileBytes) {
        this.queueResponse({ kind: "file-error", requestId, error: localExecFileTooLargeMessage(size, this.maxFileBytes) });
        return;
      }
      const bytes = await readFile(target);
      this.queueResponse({ kind: "file", requestId, bytesBase64: bytes.toString("base64") });
    } catch (error) {
      this.queueResponse({ kind: "file-error", requestId, error: errorMessage(error) });
    }
  }
}

function isDescribedRequest(frame: LocalExecRequestFrame): frame is DescribedRequest {
  return frame.kind === "exec" || frame.kind === "upload" || frame.kind === "download";
}
