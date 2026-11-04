/**
 * The product analytics this host reports.
 *
 * Events are not sent until the platform's own gate says analytics may run for this account: until then they are
 * deferred, up to a bound, so a host that is never enabled does not grow one. Once the gate is on, what was deferred
 * is handed over in the order it happened and everything after is buffered as usual. An account that turned telemetry
 * off — or whose gate check failed — has no analytics at all, and the gate subscription is let go the moment the state
 * stops being "waiting for the gate".
 */

import { AnalyticsBuffer, type AnalyticsBufferClient } from "../../../packages/analytics-client/buffer.ts";
import { DeferredAnalyticsBuffer } from "../../../packages/analytics-client/deferred-buffer.ts";
import { createSlateAnalyticsClient, createSlateAnalyticsTokenProvider } from "../../../adapters/interop/analytics/analytics-client.ts";
import { getSlateClientVersion } from "../slate-client-metadata.ts";
import { getSlateVariant } from "../slate-variant.ts";

export const SLATE_PRODUCT_ANALYTICS_GATE = "slate_product_analytics";
const MAX_DEFERRED_EVENTS = 256;
const DEFAULT_FLUSH_TIMEOUT_MS = 2_500;
const ACTIVE_EVENT = "slate.app.active";

/** One of the host-wide switches is enough to prevent analytics collection. */
function isAnalyticsOptedOut(): boolean {
  const telemetryDisabled = process.env.SLATE_DISABLE_TELEMETRY === "1";
  const analyticsDisabled = process.env.SLATE_DISABLE_ANALYTICS === "1";
  return telemetryDisabled || analyticsDisabled;
}

function isAnalyticsDebug(): boolean {
  return process.env.SLATE_ANALYTICS_DEBUG === "1";
}

function baseProperties(hostInBox: boolean): Readonly<Record<string, string | boolean>> {
  return {
    client: "slate",
    slate_version: getSlateClientVersion(),
    flavor: getSlateVariant(),
    os: process.platform,
    arch: process.arch,
    host_in_box: hostInBox,
  };
}

export type ProductAnalyticsClient = AnalyticsBufferClient

export interface ProductAnalyticsGate {
  checkGate(name: string): Promise<boolean>;
  subscribe(listener: () => void): () => void;
}

export interface ProductAnalyticsOptions {
  readonly hostInBox: boolean;
  getAccessToken(options: { backendUrl: string }): Promise<string>;
  getMachineId(): Promise<string>;
  createClient?(): ProductAnalyticsClient;
}

type AnalyticsState =
  | { kind: "disabled" }
  | { kind: "deferred"; buffer: DeferredAnalyticsBuffer }
  | { kind: "active"; buffer: AnalyticsBuffer };

export class SlateProductAnalytics {
  state: AnalyticsState;
  activated = false;
  gate: ProductAnalyticsGate | undefined;
  unsubscribeGate: (() => void) | undefined;
  baseProps: Readonly<Record<string, string | boolean>>;
  options: ProductAnalyticsOptions;
  debug = isAnalyticsDebug();
  lastActiveDayKeys = new Map<string, string>();
  private gateEvaluation: Promise<void> | undefined;

  constructor(options: ProductAnalyticsOptions) {
    this.options = options;
    this.baseProps = baseProperties(options.hostInBox);
    this.state = isAnalyticsOptedOut() ? { kind: "disabled" } : { kind: "deferred", buffer: new DeferredAnalyticsBuffer() };
  }

  /** A host has one gate subscription for the lifetime of this collector. */
  async activate(gate: ProductAnalyticsGate): Promise<void> {
    if (this.activated) return;
    this.activated = true;
    if (this.state.kind === "disabled") return;
    this.gate = gate;
    try {
      this.unsubscribeGate = gate.subscribe(() => void this.evaluateGate());
    } catch {
      this.unsubscribeGate = undefined;
    }
    await this.evaluateGate();
  }

  private evaluateGate(): Promise<void> {
    const gate = this.gate;
    if (gate == null) return Promise.resolve();
    if (this.state.kind !== "deferred") {
      this.releaseGateSubscription();
      return Promise.resolve();
    }
    if (this.gateEvaluation !== undefined) return this.gateEvaluation;

    const evaluation = Promise.resolve().then(() => this.evaluateCurrentGate(gate));
    this.gateEvaluation = evaluation;
    void evaluation.finally(() => {
      if (this.gateEvaluation === evaluation) this.gateEvaluation = undefined;
    }).catch(() => {});
    return evaluation;
  }

  private async evaluateCurrentGate(gate: ProductAnalyticsGate): Promise<void> {
    if (isAnalyticsOptedOut()) {
      this.disable("opted_out");
      return;
    }
    let enabled = false;
    try {
      enabled = await gate.checkGate(SLATE_PRODUCT_ANALYTICS_GATE);
    } catch {
      enabled = false;
    }
    if (!enabled) {
      if (this.debug) console.info(`[slate-analytics] gate ${SLATE_PRODUCT_ANALYTICS_GATE} off; buffering until a later refresh`);
      return;
    }
    this.startReporting();
  }

  private startReporting(): void {
    const deferredBuffer = this.state.kind === "deferred" ? this.state.buffer : undefined;
    try {
      const createClient = this.options.createClient ?? (() =>
        createSlateAnalyticsClient({
          getAccessToken: this.options.getAccessToken,
          getMachineId: this.options.getMachineId,
        }));
      const buffer = this.createActiveBuffer(createClient);
      if (deferredBuffer !== undefined) this.transferDeferredEvents(deferredBuffer, buffer);
      this.state = { kind: "active", buffer };
      this.releaseGateSubscription();
      if (this.debug) console.info("[slate-analytics] enabled");
    } catch (error) {
      if (this.debug) console.info("[slate-analytics] failed to enable; disabling", error);
      this.disable("error");
    }
  }

  private createActiveBuffer(createClient: () => ProductAnalyticsClient): AnalyticsBuffer {
    return new AnalyticsBuffer({
      client: createClient(),
      tokenProvider: createSlateAnalyticsTokenProvider(this.options.getAccessToken),
      ...(this.debug ? { onDebug: (tag: string, payload: unknown) => console.info(`[slate-analytics] ${tag}`, payload) } : {}),
    });
  }

  private transferDeferredEvents(source: DeferredAnalyticsBuffer, destination: AnalyticsBuffer): void {
    for (const event of source.getEvents()) {
      destination.track(event.eventName, event.props, event.timestamp);
    }
    source.clear();
  }

  private disable(reason: string): void {
    // Events that were never sent are not kept for a state that will not send them.
    if (this.state.kind === "deferred") this.state.buffer.clear();
    this.state = { kind: "disabled" };
    this.releaseGateSubscription();
    if (this.debug) console.info(`[slate-analytics] disabled (${reason})`);
  }

  private releaseGateSubscription(): void {
    if (this.unsubscribeGate == null) return;
    try {
      this.unsubscribeGate();
    } catch {
      // A subscription that will not let go is not a reason to keep holding it.
    }
    this.unsubscribeGate = undefined;
  }

  trackEvent(event: string, props: Readonly<Record<string, unknown>> = {}): void {
    if (this.state.kind !== "deferred" && this.state.kind !== "active") return;
    // Deferred events are bounded: a host that is never enabled keeps the first ones and stops growing.
    if (this.state.kind === "deferred" && this.state.buffer.getEvents().length >= MAX_DEFERRED_EVENTS) return;
    const enriched = this.enrich(props);
    if (this.debug) console.info(`[slate-analytics] track ${event}`, enriched);
    this.state.buffer.track(event, enriched);
  }

  /** Says the app was used today, once per reason per day. */
  markActive(reason: string): void {
    if (!this.canRecordEvents()) return;
    const dayKey = new Date().toISOString().slice(0, 10);
    if (this.lastActiveDayKeys.get(reason) === dayKey) return;
    this.lastActiveDayKeys.set(reason, dayKey);
    this.trackEvent(ACTIVE_EVENT, { reason });
  }

  canRecordEvents(): boolean {
    return this.state.kind === "deferred" || this.state.kind === "active";
  }

  async flush(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
    if (this.state.kind !== "active") return;
    try {
      await this.state.buffer.flush(timeoutMs);
    } catch {
      // A flush that failed is not a reason to fail the caller.
    }
  }

  async dispose(): Promise<void> {
    this.releaseGateSubscription();
    await this.flush();
  }

  private enrich(props: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    return { ...this.baseProps, ...props };
  }
}
