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

export class AnalyticsBuffer {
  private readonly buffer: AnalyticsEventMessage[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private activeFlush: Promise<number> | null = null;
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
    const timestampValue = BigInt(timestamp ?? Date.now());
    const event = new AnalyticsEventMessage({ eventName, eventData: toEventData(props), timestamp: timestampValue });
    this.buffer.push(event);
    if (this.buffer.length >= this.bufferLimit) this.flushInBackground();
    else this.scheduleFlush();
  }

  async flush(timeoutMs: number): Promise<void> {
    for (;;) {
      if (this.activeFlush !== null) {
        await this.activeFlush;
        if (this.buffer.length === 0) return;
        continue;
      }
      if (this.buffer.length === 0) return;
      const running = this.flushOnce(timeoutMs);
      this.activeFlush = running;
      let sent = 0;
      try {
        sent = await running;
      } finally {
        if (this.activeFlush === running) this.activeFlush = null;
      }
      if (this.buffer.length === 0 || sent === 0) return;
    }
  }

  private async flushOnce(timeoutMs: number): Promise<number> {
    if (this.buffer.length === 0) return 0;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timeout.unref === "function") timeout.unref();
    try {
      try {
        const token = await Promise.race([
          this.tokenProvider.getAccessToken(),
          new Promise<typeof TOKEN_CHECK_TIMEOUT>(resolve => {
            controller.signal.addEventListener("abort", () => resolve(TOKEN_CHECK_TIMEOUT), { once: true });
          }),
        ]);
        if (token === TOKEN_CHECK_TIMEOUT) {
          this.onDebug("analytics.flush.deferred", { reason: "token_check_timed_out", count: this.buffer.length });
          return 0;
        }
        if (!token) {
          this.onDebug("analytics.flush.deferred", { reason: "no_token", count: this.buffer.length });
          return 0;
        }
      } catch (error) {
        this.onDebug("analytics.flush.deferred", { reason: "token_check_failed", error, count: this.buffer.length });
        return 0;
      }
      const toSend = this.buffer.slice();
      if (toSend.length === 0) return 0;
      try {
        await this.client.trackEvents(new TrackEventsRequest({ events: toSend }), { signal: controller.signal });
        this.buffer.splice(0, toSend.length);
        return toSend.length;
      } catch (error) {
        this.onDebug("analytics.flush.error", { error });
        if (this.buffer.length > this.bufferLimit) this.buffer.splice(0, this.buffer.length - this.bufferLimit);
        return 0;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private flushInBackground(): void {
    void this.flush(this.normalFlushTimeoutMs);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushInBackground();
    }, this.flushIntervalMs);
    if (typeof this.flushTimer.unref === "function") this.flushTimer.unref();
  }
}
