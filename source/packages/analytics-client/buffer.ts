/**
 * Events waiting to be sent to the analytics service.
 *
 * Events are collected up to a bound and sent as one request; what cannot be sent is kept for the next attempt, and
 * what is too old to mean anything is dropped rather than sent late.
 */
import {
  AnalyticsEvent as AnalyticsEventMessage,
  TrackEventsRequest,
} from "../proto/generated/aiserver/v1/analytics_pb.ts";
import { toEventData, type AnalyticsEventProperties } from "./to-event-data.ts";

const DEFAULT_BUFFER_LIMIT = 200;
const DEFAULT_FLUSH_INTERVAL_MS = 3_000;
const DEFAULT_NORMAL_FLUSH_TIMEOUT_MS = 2_500;
const TOKEN_CHECK_TIMEOUT = Symbol("token_check_timeout");

export interface AnalyticsBufferClient {
  trackEvents(request: TrackEventsRequest, options: { readonly signal: AbortSignal }): Promise<unknown>;
}

export interface AnalyticsBufferTokenProvider {
  getAccessToken(): Promise<string | null | undefined>;
}

export interface AnalyticsBufferOptions {
  readonly client: AnalyticsBufferClient;
  readonly tokenProvider: AnalyticsBufferTokenProvider;
  readonly bufferLimit?: number | undefined;
  readonly flushIntervalMs?: number | undefined;
  readonly normalFlushTimeoutMs?: number | undefined;
  readonly onDebug?: ((tag: string, payload: unknown) => void) | undefined;
}

type DeliveryBatch = readonly AnalyticsEventMessage[];
type FlushResult = { readonly sent: number; readonly retained: number };

export class AnalyticsBuffer {
  private readonly buffer: AnalyticsEventMessage[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flight: Promise<FlushResult> | null = null;
  private readonly client: AnalyticsBufferClient;
  private readonly tokenProvider: AnalyticsBufferTokenProvider;
  private readonly bufferLimit: number;
  private readonly flushIntervalMs: number;
  private readonly normalFlushTimeoutMs: number;
  private readonly onDebug: (tag: string, payload: unknown) => void;

  constructor(options: AnalyticsBufferOptions) {
    this.client = options.client;
    this.tokenProvider = options.tokenProvider;
    this.bufferLimit = options.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.normalFlushTimeoutMs = options.normalFlushTimeoutMs ?? DEFAULT_NORMAL_FLUSH_TIMEOUT_MS;
    this.onDebug = options.onDebug ?? (() => {});
  }

  track(eventName: string, props: AnalyticsEventProperties | null | undefined, timestamp?: number): void {
    const eventTimestamp = BigInt(timestamp ?? Date.now());
    const message = new AnalyticsEventMessage({ eventName, eventData: toEventData(props), timestamp: eventTimestamp });
    this.buffer.push(message);
    this.onQueueGrowth();
  }

  async flush(timeoutMs: number): Promise<void> {
    while (this.buffer.length > 0) {
      if (this.flight !== null) {
        const finished = await this.flight;
        if (finished.sent === 0 || this.buffer.length === 0) return;
        continue;
      }
      const flight = this.flushBatch(timeoutMs);
      this.flight = flight;
      try {
        const result = await flight;
        if (result.sent === 0) return;
      } finally {
        if (this.flight === flight) this.flight = null;
      }
    }
  }

  private onQueueGrowth(): void {
    if (this.buffer.length >= this.bufferLimit) this.flushInBackground();
    else this.armTimer();
  }

  private async flushBatch(timeoutMs: number): Promise<FlushResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const token = await this.readToken(controller);
      if (token === null) return { sent: 0, retained: this.buffer.length };
      const batch = this.buffer.slice();
      if (batch.length === 0) return { sent: 0, retained: 0 };
      return await this.deliver(batch, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readToken(controller: AbortController): Promise<string | null> {
    try {
      const token = await Promise.race([
        this.tokenProvider.getAccessToken(),
        new Promise<typeof TOKEN_CHECK_TIMEOUT>(resolve => {
          controller.signal.addEventListener("abort", () => resolve(TOKEN_CHECK_TIMEOUT), { once: true });
        }),
      ]);
      if (token === TOKEN_CHECK_TIMEOUT) {
        this.onDebug("analytics.flush.deferred", { reason: "token_check_timed_out", count: this.buffer.length });
        return null;
      }
      if (!token) {
        this.onDebug("analytics.flush.deferred", { reason: "no_token", count: this.buffer.length });
        return null;
      }
      return token;
    } catch (error) {
      this.onDebug("analytics.flush.deferred", { reason: "token_check_failed", error, count: this.buffer.length });
      return null;
    }
  }

  private async deliver(batch: DeliveryBatch, signal: AbortSignal): Promise<FlushResult> {
    try {
      await this.client.trackEvents(new TrackEventsRequest({ events: [...batch] }), { signal });
      this.buffer.splice(0, batch.length);
      return { sent: batch.length, retained: this.buffer.length };
    } catch (error) {
      this.onDebug("analytics.flush.error", { error });
      return { sent: 0, retained: this.trimTail() };
    }
  }

  private trimTail(): number {
    const excess = Math.max(0, this.buffer.length - this.bufferLimit);
    if (excess > 0) this.buffer.splice(0, excess);
    return this.buffer.length;
  }

  private flushInBackground(): void {
    void this.flush(this.normalFlushTimeoutMs);
  }

  private armTimer(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushInBackground();
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }
}
