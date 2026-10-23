/**
 * The client the coordinator uses to speak to the host's gateway.
 *
 * A command is sent with its own deadline and answered with either the outcome or the error the gateway reported; a
 * link that idles is watched, a transport that broke is retried with the policy the platform resolved, and a
 * request that never lands is reported as a deadline rather than left hanging.
 */
import { randomUUID } from "node:crypto";

import {
  DeadlineExceededError,
  createDeadlinePolicy,
  createIdleWatchdogPolicy,
  createRetryPolicy,
  realClock,
  type Clock,
  type DeadlinePolicy,
  type IdleWatchdogPolicy,
  type RetryPolicy
} from "../../host/extensions/scheduling.ts";
import { findBoxBlockedMessage, SLATE_CLIENT_PAUSE_BLOCKED_MESSAGE } from "../../shared/gateway-reachability.ts";
import {
  GATEWAY_API_PREFIX,
  GATEWAY_AUTH_SCHEME,
  GATEWAY_EVENTS_PATH,
  GATEWAY_MINT_DEDUPE_HEADER,
  GATEWAY_SLIM_AVATARS_HEADER,
  GATEWAY_TRACEPARENT_HEADER
} from "../../shared/gateway-wire.ts";
import { deriveChildTraceparent } from "../../shared/observability/send-trace.ts";
import { proxifyForeverBoxStatus, type ForeverBoxStatus, type VncProxyDescriptor } from "./box-vnc-proxy.ts";
import { SlateGatewayCommandError } from "./gateway-errors.ts";
import {
  SlateGatewayUnreachableError,
  classifyBaseUrlKind,
  classifyGatewayError,
  classifyStreamDown,
  outcomeForHttpStatus
} from "./gateway-reachability.ts";
import { SseBlockDecoder } from "./sse-block-decoder.ts";

export const PERMANENT_REFUSAL_KINDS = new Set(["no_storage", "box_blocked", "access_denied"]);
export const PRE_DISPATCH_KINDS = new Set(["refused", "dns"]);
export const CREATE_AGENT_RETRY_POLICY = { name: "gateway-create-agent-retry", maxAttempts: 3, initialDelayMs: 1_000, maxDelayMs: 4_000, backoffFactor: 2 } as const;
export const SSE_RECONNECT_MIN_MS = 1_000;
export const SSE_RECONNECT_MAX_MS = 10_000;
export const SSE_STALL_TIMEOUT_MS = 35_000;
export const SSE_CONNECT_TIMEOUT_MS = 15_000;
export const SEND_POST_TIMEOUT_MS = 15_000;
export const ROSTER_READ_TIMEOUT_MS = 15_000;
export const TRACE_WINDOW_ROOT_CACHE_MS = 5_000;
export const HOST_ACCOUNT_SLOT = "host";

const DISABLE_SEND_ACCEPT_RETURN_ENV = "SLATE_DISABLE_SEND_ACCEPT_RETURN";
const SEND_POST_TIMEOUT_ENV = "SLATE_SEND_POST_TIMEOUT_MS";
const ROSTER_READ_TIMEOUT_ENV = "SLATE_ROSTER_READ_TIMEOUT_MS";
const DISABLE_SLIM_AVATARS_ENV = "SLATE_DISABLE_SLIM_AVATARS";

export function extractGatewayErrorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { readonly error?: unknown };
    return typeof parsed.error === "string" && parsed.error.length > 0 ? parsed.error : null;
  } catch { return null; }
}

export { SlateGatewayCommandError } from "./gateway-errors.ts";
export class GatewayEndpointChangedError extends Error {}

export interface GatewayClientTiming {
  readonly clock: Clock;
  readonly reconnectBackoff: RetryPolicy;
  readonly connectDeadline: DeadlinePolicy;
  readonly stallWatchdog: IdleWatchdogPolicy;
  readonly sendPostDeadline: DeadlinePolicy;
  readonly rosterReadDeadline: DeadlinePolicy;
  readonly createAgentRetry: RetryPolicy;
}

export function createCoordinatorGatewayClientTiming(): GatewayClientTiming {
  const overrideMs = Number(process.env[SEND_POST_TIMEOUT_ENV]);
  const sendPostTimeoutMs = Number.isFinite(overrideMs) && overrideMs > 0 ? overrideMs : SEND_POST_TIMEOUT_MS;
  const rosterReadOverrideMs = Number(process.env[ROSTER_READ_TIMEOUT_ENV]);
  const rosterReadTimeoutMs = Number.isFinite(rosterReadOverrideMs) && rosterReadOverrideMs > 0 ? rosterReadOverrideMs : ROSTER_READ_TIMEOUT_MS;
  return {
    clock: realClock,
    reconnectBackoff: createRetryPolicy(realClock, { name: "gateway-sse-reconnect-backoff", maxAttempts: Number.MAX_SAFE_INTEGER, initialDelayMs: SSE_RECONNECT_MIN_MS, maxDelayMs: SSE_RECONNECT_MAX_MS, backoffFactor: 2 }),
    connectDeadline: createDeadlinePolicy(realClock, { name: "gateway-sse-connect", timeoutMs: SSE_CONNECT_TIMEOUT_MS }),
    stallWatchdog: createIdleWatchdogPolicy(realClock, { name: "gateway-sse-stall", idleMs: SSE_STALL_TIMEOUT_MS }),
    sendPostDeadline: createDeadlinePolicy(realClock, { name: "gateway-send-post", timeoutMs: sendPostTimeoutMs }),
    rosterReadDeadline: createDeadlinePolicy(realClock, { name: "gateway-roster-read", timeoutMs: rosterReadTimeoutMs }),
    createAgentRetry: createRetryPolicy(realClock, CREATE_AGENT_RETRY_POLICY)
  };
}

export interface GatewayConnection {
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly token?: string | null;
  readonly vncProxy?: VncProxyDescriptor | null;
}

export function withAuth(headers: Record<string, string>, link: GatewayConnection): Record<string, string> {
  const merged = { ...headers, ...(link.headers ?? {}) };
  if (link.token != null && link.token.length > 0) merged.authorization = `${GATEWAY_AUTH_SCHEME} ${link.token}`;
  return merged;
}

export interface CoordinatorGatewayClientOptions {
  readonly resolveConnection: (signal?: AbortSignal) => Promise<GatewayConnection>;
  readonly timing: GatewayClientTiming;
  readonly onEvent: (event: { readonly channel: string; readonly payload: unknown }) => void;
  readonly onTransportEvent?: (event: unknown) => void;
  readonly onTransportRetry?: () => void;
  readonly onReachability?: (report: unknown, baseUrl?: string) => void;
  readonly recordTransportStage?: (report: unknown) => void;
  readonly recordGatewayCommandSpan?: (report: unknown) => void;
  readonly resolveTraceWindowTraceparent?: () => Promise<string | null | undefined>;
}

type RequestInit = { readonly signal?: AbortSignal; readonly requiredBaseUrl?: string };

export class CoordinatorGatewayClient {
  private closedFlag = false;
  private forcedOffline = false;
  private pausedClient = false;
  private linkState: "initial" | "connected" | "disconnected" = "initial";
  private loopHandle: Promise<void> | undefined;
  private loopAbort: AbortController | undefined;
  private reconnectEpoch = 0;
  private forcedReconnectWait: (ReturnType<typeof Promise.withResolvers<void>> & { generation: number }) | undefined;
  private connectCount = 0;
  private readonly sendAcceptSkipped: boolean;
  private readonly slimAvatarsOff: boolean;
  private traceRootCache: { expiresAtMonotonicMs: number; root?: string } | undefined;
  private traceRootInflight: Promise<void> | undefined;
  private spanSinkDead = false;
  private readonly settings: Omit<CoordinatorGatewayClientOptions, "resolveConnection">;
  private readonly resolveUpstream: CoordinatorGatewayClientOptions["resolveConnection"];
  private readonly mintProvenBaseUrls = new Set<string>();
  private readonly sendProvenBaseUrls = new Set<string>();

  constructor(settings: CoordinatorGatewayClientOptions) {
    const { resolveConnection, ...rest } = settings;
    this.settings = rest;
    this.resolveUpstream = resolveConnection;
    this.sendAcceptSkipped = process.env[DISABLE_SEND_ACCEPT_RETURN_ENV] === "1";
    this.slimAvatarsOff = process.env[DISABLE_SLIM_AVATARS_ENV] === "1";
  }

  requestHeaders(base: Record<string, string>, link: GatewayConnection): Record<string, string> {
    const headers = withAuth(base, link);
    if (!this.slimAvatarsOff) headers[GATEWAY_SLIM_AVATARS_HEADER] = "1";
    return headers;
  }

  private cachedTraceRoot(): string | undefined {
    const resolve = this.settings.resolveTraceWindowTraceparent;
    if (resolve === undefined) return undefined;
    const now = this.settings.timing.clock.monotonicNow();
    const cached = this.traceRootCache;
    const isFresh = cached !== undefined && now < cached.expiresAtMonotonicMs;
    if (!isFresh && this.traceRootInflight === undefined) {
      const inflight = this.fetchTraceRoot(resolve).finally(() => {
        if (this.traceRootInflight === inflight) this.traceRootInflight = undefined;
      });
      this.traceRootInflight = inflight;
    }
    return cached?.root;
  }

  private async fetchTraceRoot(resolve: () => Promise<string | null | undefined>): Promise<void> {
    try {
      const root = await resolve() ?? undefined;
      this.traceRootCache = { expiresAtMonotonicMs: this.settings.timing.clock.monotonicNow() + TRACE_WINDOW_ROOT_CACHE_MS, ...(root === undefined ? {} : { root }) };
    } catch { this.traceRootCache = undefined; }
  }

  start(): void {
    if (this.closedFlag || this.loopHandle != null) return;
    this.loopHandle = this.runLoop().finally(() => { this.loopHandle = undefined; });
  }

  forceReconnect(): Promise<void> {
    if (this.closedFlag) return Promise.reject(new Error("gateway client is closed"));
    if (this.forcedReconnectWait != null) {
      this.reconnectEpoch += 1;
      this.abortLoopAttempt();
      return this.forcedReconnectWait.promise;
    }
    const deferred = Promise.withResolvers<void>();
    this.reconnectEpoch += 1;
    this.forcedReconnectWait = { ...deferred, generation: this.reconnectEpoch };
    this.abortLoopAttempt();
    return deferred.promise;
  }

  private abortLoopAttempt(): void {
    if (this.linkState !== "connected") this.markDisconnected("forcedNow-reconnect", null);
    this.loopAbort?.abort();
    this.start();
  }

  private emitTransport(event: unknown): void { this.settings.onTransportEvent?.(event); }

  setDevInducedOffline(induced: boolean): { induced: boolean } {
    if (this.forcedOffline !== induced) { this.forcedOffline = induced; this.loopAbort?.abort(); }
    return { induced: this.forcedOffline };
  }

  setClientPaused(paused: boolean): { paused: boolean } {
    if (this.pausedClient !== paused) { this.pausedClient = paused; this.loopAbort?.abort(); }
    return { paused: this.pausedClient };
  }

  async resolveConnection(signal?: AbortSignal): Promise<GatewayConnection> {
    if (this.pausedClient) throw new SlateGatewayUnreachableError("box_blocked", SLATE_CLIENT_PAUSE_BLOCKED_MESSAGE, { causeSummary: "client-paused" });
    if (this.forcedOffline) throw new SlateGatewayUnreachableError("network", "gateway offline: induced by dev controls", { causeSummary: "dev-induced-offline" });
    return await this.resolveUpstream(signal);
  }

  private markDisconnected(reason: string, cause: string | null): void {
    if (this.closedFlag || this.linkState === "disconnected") return;
    this.linkState = "disconnected";
    this.emitTransport({ family: "transport-disconnect", payload: { generation: this.connectCount, reason, cause } });
  }

  close(): void {
    this.closedFlag = true;
    this.loopAbort?.abort();
    this.forcedReconnectWait?.reject(new Error("gateway client closed"));
    this.forcedReconnectWait = undefined;
  }

  private reportReachable(report: unknown, baseUrl?: string): void {
    if (this.pausedClient) return;
    try { this.settings.onReachability?.(report, baseUrl); } catch {}
  }

  private recordSendPhase(stage: Record<string, unknown>): void {
    const recorder = this.settings.recordTransportStage;
    const clientNonce = stage.clientNonce;
    if (recorder == null || typeof clientNonce !== "string" || clientNonce.length === 0) return;
    try { recorder({ accountSlot: HOST_ACCOUNT_SLOT, ...stage, clientNonce, traceparent: stage.traceparent ?? null, isError: stage.isError === true }); } catch {}
  }

  private reportSpan(method: string, spanTrace: { root: string; child: { spanId: string } } | undefined, settle: Record<string, unknown>): void {
    const sink = this.settings.recordGatewayCommandSpan;
    if (spanTrace === undefined || sink == null || this.spanSinkDead) return;
    try { sink({ method, rootTraceparent: spanTrace.root, spanId: spanTrace.child.spanId, ...settle }); }
    catch { this.spanSinkDead = true; }
  }

  async request(method: string, payload: unknown, requestInit?: RequestInit): Promise<{ result: unknown; connection: GatewayConnection }> {
    const startMono = this.settings.timing.clock.monotonicNow();
    let link: GatewayConnection | undefined;
    let spanTrace: { root: string; child: { traceparent: string; spanId: string } } | undefined;
    let fetchStartMono = startMono;
    let fetchStartEpoch = 0;
    try {
      link = await this.resolveConnection(requestInit?.signal);
      if (requestInit?.requiredBaseUrl != null && link.baseUrl !== requestInit.requiredBaseUrl) throw new GatewayEndpointChangedError();
      const root = this.cachedTraceRoot();
      const child = root !== undefined && this.settings.recordGatewayCommandSpan != null ? deriveChildTraceparent(root) : undefined;
      if (root !== undefined && child !== undefined) spanTrace = { root, child };
      const traceparent = child?.traceparent ?? root;
      fetchStartMono = this.settings.timing.clock.monotonicNow();
      fetchStartEpoch = this.settings.timing.clock.now();
      const reply = await fetch(`${link.baseUrl}${GATEWAY_API_PREFIX}/${method}`, {
        method: "POST",
        headers: this.requestHeaders({ "content-type": "application/json", ...(traceparent === undefined ? {} : { [GATEWAY_TRACEPARENT_HEADER]: traceparent }) }, link),
        body: JSON.stringify(payload ?? {}),
        ...(requestInit?.signal == null ? {} : { signal: requestInit.signal })
      });
      if (!reply.ok) {
        const detail = await reply.text().catch(() => reply.statusText);
        const message = extractGatewayErrorMessage(detail) ?? `gateway ${method} failed: ${detail}`;
        if (reply.status < 500) throw new SlateGatewayCommandError(message);
        throw new SlateGatewayUnreachableError("http_5xx", message, { httpStatus: reply.status, attemptedBaseUrl: link.baseUrl });
      }
      const outcome = await reply.json() as unknown;
      if (reply.headers.get(GATEWAY_MINT_DEDUPE_HEADER) === "1") this.mintProvenBaseUrls.add(link.baseUrl);
      this.reportSpan(method, spanTrace, { startEpochMs: fetchStartEpoch, durationMs: this.settings.timing.clock.monotonicNow() - fetchStartMono, isError: false });
      return { result: outcome, connection: link };
    } catch (error) {
      this.reportSpan(method, spanTrace, { startEpochMs: fetchStartEpoch, durationMs: this.settings.timing.clock.monotonicNow() - fetchStartMono, isError: true });
      if (error instanceof SlateGatewayCommandError || error instanceof GatewayEndpointChangedError) throw error;
      const verdict = classifyGatewayError(error);
      this.reportReachable({ outcome: verdict.outcome, method, latencyMs: this.settings.timing.clock.monotonicNow() - startMono, baseUrlKind: classifyBaseUrlKind(link?.baseUrl), ...(verdict.httpStatus === undefined ? {} : { httpStatus: verdict.httpStatus }), ...(verdict.causeSummary === undefined ? {} : { causeSummary: verdict.causeSummary }) }, link?.baseUrl);
      if (error instanceof SlateGatewayUnreachableError) throw error;
      const blockedText = findBoxBlockedMessage(error);
      throw new SlateGatewayUnreachableError(verdict.outcome, blockedText == null ? `gateway ${method} unreachable (${verdict.outcome})` : `gateway ${method} unreachable (${verdict.outcome}): ${blockedText}`, { cause: error, ...(verdict.causeSummary === undefined ? {} : { causeSummary: verdict.causeSummary }), ...(link === undefined ? {} : { attemptedBaseUrl: link.baseUrl }), isPreDispatch: link === undefined });
    }
  }

  async command(method: string, payload: unknown, requestInit?: RequestInit): Promise<unknown> { return (await this.request(method, payload, requestInit)).result; }

  dispatchCommand(method: string, payload: unknown, requestInit?: RequestInit): Promise<unknown> {
    const record = typeof payload === "object" && payload != null ? payload as Record<string, unknown> : {};
    if (method === "sendWithDedupe") return this.sendWithDedupe(record);
    if (method === "getForeverBoxStatus" || method === "ensureForeverBox") return this.foreverBoxStatus(method, payload, requestInit);
    if (method === "listAgents" || method === "countAgents") return this.boundedRoster(method, requestInit);
    if (method === "createAgent") return this.retryCreateAgent(record, requestInit);
    if (method === "setDevGatewayOffline") return Promise.resolve(this.setDevInducedOffline(record.induced === true));
    if (method === "setGatewayPaused") return Promise.resolve(this.setClientPaused(record.paused === true));
    return this.command(method, payload, requestInit);
  }

  async dispatchLegacyCommand(method: string, payload: unknown): Promise<void> { await this.command(method, payload); }

  private async retryCreateAgent(payload: Record<string, unknown>, requestInit?: RequestInit): Promise<unknown> {
    const tagged = { ...payload, clientNonce: payload.clientNonce ?? randomUUID() };
    let pinnedUrl: string | undefined;
    let previousFailure: unknown;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return (await this.request("createAgent", tagged, { ...(requestInit?.signal == null ? {} : { signal: requestInit.signal }), ...(pinnedUrl == null ? {} : { requiredBaseUrl: pinnedUrl }) })).result;
      } catch (error) {
        if (error instanceof GatewayEndpointChangedError) throw previousFailure;
        previousFailure = error;
        const canRetry = attempt < CREATE_AGENT_RETRY_POLICY.maxAttempts && requestInit?.signal?.aborted !== true && !(error instanceof SlateGatewayCommandError) && !(error instanceof SlateGatewayUnreachableError && PERMANENT_REFUSAL_KINDS.has(error.kind));
        if (!canRetry) throw error;
        const beforeDispatch = error instanceof SlateGatewayUnreachableError && (error.isPreDispatch === true || PRE_DISPATCH_KINDS.has(error.kind));
        if (!beforeDispatch) {
          const triedUrl = error instanceof SlateGatewayUnreachableError ? error.attemptedBaseUrl : undefined;
          if (triedUrl == null || !this.mintProvenBaseUrls.has(triedUrl)) throw error;
          pinnedUrl = triedUrl;
        }
      }
      const backoffWait = this.settings.timing.createAgentRetry.schedule(attempt, requestInit?.signal);
      try { await backoffWait.elapsed; } finally { backoffWait.dispose(); }
      this.noteRetry();
    }
  }

  private noteRetry(): void { try { this.settings.onTransportRetry?.(); } catch {} }

  private async boundedRoster(method: string, requestInit?: RequestInit): Promise<unknown> {
    try { return await this.rosterAttempt(method, requestInit); }
    catch (error) {
      const canRetry = !this.closedFlag && requestInit?.signal?.aborted !== true && !(error instanceof SlateGatewayCommandError) && !(error instanceof SlateGatewayUnreachableError && PERMANENT_REFUSAL_KINDS.has(error.kind));
      if (!canRetry) throw error;
      this.noteRetry();
      return await this.rosterAttempt(method, requestInit);
    }
  }

  private async rosterAttempt(method: string, requestInit?: RequestInit): Promise<unknown> {
    try { return await this.settings.timing.rosterReadDeadline.run((signal) => this.command(method, {}, { signal }), requestInit?.signal); }
    catch (error) {
      if (error instanceof DeadlineExceededError) throw new SlateGatewayUnreachableError("timeout", `gateway ${method} unreachable (timeout)`, { cause: error });
      throw error;
    }
  }

  private async sendWithDedupe(payload: Record<string, unknown>): Promise<unknown> {
    if (this.sendAcceptSkipped) return await this.command("sendWithDedupe", payload);
    const first = { baseUrl: undefined as string | undefined, postStarted: false };
    try { return await this.sendAttempt(payload, 0, first); }
    catch (error) {
      const postNeverDispatched = !first.postStarted;
      const clientNonce = payload.clientNonce;
      const dedupeProven = first.baseUrl != null && this.sendProvenBaseUrls.has(first.baseUrl);
      const canRetry = !this.closedFlag && typeof clientNonce === "string" && clientNonce.length > 0 && !(error instanceof SlateGatewayCommandError) && (postNeverDispatched || dedupeProven);
      if (!canRetry) throw error;
      this.noteRetry();
      return await this.sendAttempt(payload, 1, { baseUrl: undefined, postStarted: false }, postNeverDispatched ? undefined : first.baseUrl);
    }
  }

  private async sendAttempt(payload: Record<string, unknown>, attempt: number, state: { baseUrl: string | undefined; postStarted: boolean }, requiredBaseUrl?: string): Promise<unknown> {
    const clock = this.settings.timing.clock;
    const connectStartEpochMs = clock.now();
    const connectStartMono = clock.monotonicNow();
    const link = await this.resolveConnection();
    state.baseUrl = link.baseUrl;
    if (requiredBaseUrl != null && link.baseUrl !== requiredBaseUrl) throw new Error("send retry aborted: the gateway endpoint changed mid-send");
    this.recordSendPhase({ stage: "gateway-connect", attempt, clientNonce: payload.clientNonce, traceparent: payload.traceparent, startEpochMs: connectStartEpochMs, durationMs: clock.monotonicNow() - connectStartMono });
    const postStartEpochMs = clock.now();
    const postStartMonotonicMs = clock.monotonicNow();
    try {
      state.postStarted = true;
      const outcome = await this.settings.timing.sendPostDeadline.run(async (signal) => {
        const reply = await fetch(`${link.baseUrl}${GATEWAY_API_PREFIX}/sendWithDedupe`, { method: "POST", headers: this.requestHeaders({ "content-type": "application/json" }, link), body: JSON.stringify(payload), signal });
        if (!reply.ok) {
          const detail = await reply.text().catch(() => reply.statusText);
          throw new SlateGatewayCommandError(extractGatewayErrorMessage(detail) ?? `gateway sendWithDedupe failed: ${detail}`);
        }
        return await reply.json() as unknown;
      });
      if (typeof outcome === "object" && outcome != null && "accepted" in outcome && outcome.accepted === true) this.sendProvenBaseUrls.add(link.baseUrl);
      this.recordSendPhase({ stage: "gateway-post", attempt, clientNonce: payload.clientNonce, traceparent: payload.traceparent, startEpochMs: postStartEpochMs, durationMs: clock.monotonicNow() - postStartMonotonicMs });
      return outcome ?? undefined;
    } catch (error) {
      this.recordSendPhase({ stage: "gateway-post", attempt, clientNonce: payload.clientNonce, traceparent: payload.traceparent, startEpochMs: postStartEpochMs, durationMs: clock.monotonicNow() - postStartMonotonicMs, isError: true });
      throw error;
    }
  }

  private async foreverBoxStatus(method: string, payload: unknown, requestInit?: RequestInit): Promise<unknown> {
    const { result: outcome, connection: link } = await this.request(method, payload, requestInit);
    return outcome == null ? null : proxifyForeverBoxStatus(outcome as ForeverBoxStatus, link.vncProxy ?? null);
  }

  private async runLoop(): Promise<void> {
    let failedAttempts = 0;
    while (!this.closedFlag) {
      const generation = this.reconnectEpoch;
      try { await this.streamEventLoop(() => { failedAttempts = 0; }, generation); } catch {}
      if (this.closedFlag) break;
      if (generation !== this.reconnectEpoch) { failedAttempts = 0; continue; }
      const backoffAbort = new AbortController();
      this.loopAbort = backoffAbort;
      if (generation !== this.reconnectEpoch) { this.loopAbort = undefined; failedAttempts = 0; continue; }
      failedAttempts += 1;
      const backoffWait = this.settings.timing.reconnectBackoff.schedule(failedAttempts, backoffAbort.signal);
      try { await backoffWait.elapsed; } catch {} finally { backoffWait.dispose(); }
      if (this.loopAbort === backoffAbort) this.loopAbort = undefined;
      if (generation !== this.reconnectEpoch) failedAttempts = 0;
    }
  }

  private async streamEventLoop(resetBackoff: () => void, attemptEpoch: number): Promise<void> {
    const controller = new AbortController();
    this.loopAbort = controller;
    const connectStartMono = this.settings.timing.clock.monotonicNow();
    let link: GatewayConnection | undefined;
    let connectedOnce = false;
    try {
      let linkHandshake: { link: GatewayConnection; streamReader: ReadableStreamDefaultReader<Uint8Array> };
      try {
        linkHandshake = await this.settings.timing.connectDeadline.run(async (deadlineSignal) => {
          const resolved = await this.resolveConnection(deadlineSignal);
          link = resolved;
          const reply = await fetch(`${resolved.baseUrl}${GATEWAY_EVENTS_PATH}`, { headers: this.requestHeaders({ accept: "text/event-stream" }, resolved), signal: controller.signal });
          if (controller.signal.aborted || attemptEpoch !== this.reconnectEpoch) {
            void reply.body?.cancel().catch(() => {});
            throw new Error("gateway connect superseded");
          }
          if (!reply.ok || reply.body == null) throw new SlateGatewayUnreachableError(outcomeForHttpStatus(reply.status) ?? "network", `gateway events failed: ${reply.status}`, { httpStatus: reply.status });
          return { link: resolved, streamReader: reply.body.getReader() };
        }, controller.signal);
      } catch (error) { if (error instanceof DeadlineExceededError) controller.abort(); throw error; }
      const { streamReader } = linkHandshake;
      resetBackoff();
      this.connectCount += 1;
      connectedOnce = true;
      this.linkState = "connected";
      const eventDecoder = new SseBlockDecoder((block) => this.dispatchEventBlock(block, linkHandshake.link.vncProxy ?? null));
      let stallTripped = false;
      const stallTimer = this.settings.timing.stallWatchdog.arm(() => { stallTripped = true; controller.abort(); });
      let disconnect = { reason: "stream-ended", cause: null as string | null };
      try {
        this.reportReachable({ outcome: "ok", method: "events", latencyMs: this.settings.timing.clock.monotonicNow() - connectStartMono, baseUrlKind: classifyBaseUrlKind(linkHandshake.link.baseUrl) }, linkHandshake.link.baseUrl);
        const forcedNow = this.forcedReconnectWait != null && this.forcedReconnectWait.generation <= attemptEpoch;
        this.emitTransport({ family: "transport-connected", payload: { generation: this.connectCount } });
        if (forcedNow) { this.forcedReconnectWait?.resolve(); this.forcedReconnectWait = undefined; }
        for (;;) {
          const outcome = await streamReader.read();
          if (outcome.done) break;
          stallTimer.kick();
          eventDecoder.push(outcome.value);
        }
      } catch (error) {
        disconnect = classifyStreamDown({ stalled: stallTripped, forced: attemptEpoch !== this.reconnectEpoch, devInducedOffline: this.forcedOffline, clientPaused: this.pausedClient, error });
        throw error;
      } finally { stallTimer.dispose(); controller.abort(); this.markDisconnected(disconnect.reason, disconnect.cause); }
    } catch (error) {
      if (!connectedOnce && !this.closedFlag && attemptEpoch === this.reconnectEpoch) {
        const verdict = classifyGatewayError(error);
        this.reportReachable({ outcome: verdict.outcome, method: "events", latencyMs: this.settings.timing.clock.monotonicNow() - connectStartMono, baseUrlKind: classifyBaseUrlKind(link?.baseUrl), ...(verdict.httpStatus === undefined ? {} : { httpStatus: verdict.httpStatus }), ...(verdict.causeSummary === undefined ? {} : { causeSummary: verdict.causeSummary }) }, link?.baseUrl);
      }
      throw error;
    } finally { if (this.loopAbort === controller) this.loopAbort = undefined; }
  }

  dispatchEventBlock(block: string, vncProxy: VncProxyDescriptor | null): void {
    const dataLines = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice("data:".length).trim());
    if (dataLines.length === 0) return;
    try {
      const event = JSON.parse(dataLines.join("\n")) as { readonly channel?: unknown; readonly payload?: unknown };
      if (typeof event.channel !== "string" || event.channel.length === 0) return;
      if (event.channel === "forever-box") this.settings.onEvent({ channel: "forever-box", payload: proxifyForeverBoxStatus(event.payload as ForeverBoxStatus, vncProxy) });
      else this.settings.onEvent({ channel: event.channel, payload: event.payload });
    } catch {}
  }
}
