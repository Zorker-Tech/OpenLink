/** Readiness polling and outage reporting for the local execution daemon. */
import { createContext, type Context } from "../../packages/context/context.ts";
import { setTimeout as delay } from "node:timers/promises";
import { SlateBoxDaemonUnreachableError } from "../ports/box.ts";
import {
  DAEMON_READY_TIMEOUT_MS,
  DAEMON_WATCHDOG_INTERVAL_MS,
  EXEC_DAEMON_PORT,
  type BoxEndpoint,
  type DaemonPingReport,
  type LoopbackOperations,
  type LoopbackTelemetry,
  type PingResult,
} from "./loopback-box-contracts.ts";

export function daemonPingReadinessState(outcome: string): string {
  if (outcome === "refused") return "up_but_exec_refused";
  if (outcome === "timeout") return "up_but_exec_unresponsive";
  return "up_but_exec_disconnected";
}

export interface LoopbackDaemonReadinessOptions {
  operations: Pick<LoopbackOperations, "ping" | "now" | "sleep">;
  telemetry?: LoopbackTelemetry;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  watchdogIntervalMs?: number;
}

type WatchdogState = "ready" | "unready" | undefined;

export class LoopbackDaemonReadiness {
  private readonly readyTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly watchdogIntervalMs: number;
  private telemetry: LoopbackTelemetry | undefined;
  private readonly watchdogAbort = new AbortController();
  private watchdogStarted = false;
  private watchdogRun: Promise<void> | undefined;
  private watchdogPoll: Promise<void> | undefined;
  private foregroundWaits = 0;
  private watchdogState: WatchdogState;
  private outageStartedAt: number | undefined;
  private outageAttempts = 0;

  constructor(private readonly options: LoopbackDaemonReadinessOptions) {
    this.readyTimeoutMs = options.readyTimeoutMs ?? DAEMON_READY_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.watchdogIntervalMs = options.watchdogIntervalMs ?? DAEMON_WATCHDOG_INTERVAL_MS;
    this.telemetry = options.telemetry;
  }

  setTelemetry(telemetry: LoopbackTelemetry): void {
    this.telemetry = telemetry;
  }

  async waitUntilReady(ctx: Context, endpoint: BoxEndpoint, timeoutMs = this.readyTimeoutMs): Promise<void> {
    if (endpoint.port !== EXEC_DAEMON_PORT) {
      await this.waitUntilReadyUncoordinated(ctx, endpoint, timeoutMs);
      return;
    }

    this.foregroundWaits += 1;
    try {
      await this.watchdogPoll;
      await this.waitUntilReadyUncoordinated(ctx, endpoint, timeoutMs);
    } finally {
      this.foregroundWaits -= 1;
    }
  }

  async waitUntilReadyUncoordinated(ctx: Context, endpoint: BoxEndpoint, timeoutMs: number): Promise<void> {
    const startedAt = this.now();
    const target = `${endpoint.host}:${endpoint.port}`;
    let attempts = 0;
    let lastResult: PingResult | undefined;
    let firstUnreadyAt: number | undefined;

    while (this.now() - startedAt < timeoutMs) {
      attempts += 1;
      lastResult = await this.options.operations.ping(ctx, endpoint);
      if (lastResult.outcome === "ok") {
        this.reportForegroundRecovery(endpoint, attempts, startedAt, firstUnreadyAt, target);
        if (endpoint.port === EXEC_DAEMON_PORT) {
          this.watchdogState = "ready";
          this.outageStartedAt = undefined;
          this.outageAttempts = 0;
          this.startWatchdog(endpoint);
        }
        return;
      }

      firstUnreadyAt ??= this.now();
      await this.sleep(this.pollIntervalMs);
    }

    const outcome = lastResult == null || lastResult.outcome === "ok" ? "refused" : lastResult.outcome;
    const endedAt = this.now();
    this.report({
      outcome,
      attempts,
      durationMs: endedAt - startedAt,
      unreadyDurationMs: endedAt - (firstUnreadyAt ?? startedAt),
      readinessState: daemonPingReadinessState(outcome),
      target,
      ...(lastResult?.causeSummary == null ? {} : { causeSummary: lastResult.causeSummary }),
    });

    if (endpoint.port === EXEC_DAEMON_PORT && this.watchdogStarted) {
      if (this.watchdogState === "ready") {
        this.outageStartedAt = firstUnreadyAt ?? startedAt;
        this.outageAttempts = attempts;
      } else {
        this.outageAttempts += attempts;
      }
      this.watchdogState = "unready";
    }

    throw new SlateBoxDaemonUnreachableError(
      outcome,
      `loopback slate box exec-daemon at ${target} not ready within ${timeoutMs}ms (last ping: ${outcome}${lastResult?.causeSummary == null ? "" : ` [${lastResult.causeSummary}]`})`,
    );
  }

  private reportForegroundRecovery(
    endpoint: BoxEndpoint,
    attempts: number,
    startedAt: number,
    firstUnreadyAt: number | undefined,
    target: string,
  ): void {
    if (attempts <= 1 && !(endpoint.port === EXEC_DAEMON_PORT && this.watchdogState === "unready")) return;

    const outageWasTracked = endpoint.port === EXEC_DAEMON_PORT && this.watchdogState === "unready";
    const unreadyAt = outageWasTracked ? this.outageStartedAt ?? startedAt : firstUnreadyAt ?? startedAt;
    const wholeAttemptCount = outageWasTracked ? this.outageAttempts + attempts : attempts;
    const endedAt = this.now();
    this.report({
      outcome: "ok",
      attempts: wholeAttemptCount,
      durationMs: endedAt - (outageWasTracked ? unreadyAt : startedAt),
      unreadyDurationMs: endedAt - unreadyAt,
      readinessState: "ready_after_retry",
      target,
    });
  }

  private startWatchdog(endpoint: BoxEndpoint): void {
    if (this.telemetry === undefined || this.watchdogStarted || this.watchdogIntervalMs <= 0) return;
    this.watchdogState = "ready";
    this.watchdogStarted = true;
    this.watchdogRun = this.runWatchdog(endpoint);
  }

  private async runWatchdog(endpoint: BoxEndpoint): Promise<void> {
    try {
      while (!this.watchdogAbort.signal.aborted) {
        await this.sleep(this.watchdogIntervalMs, this.watchdogAbort.signal);
        if (this.watchdogAbort.signal.aborted) break;
        if (this.foregroundWaits > 0) continue;

        const tick = this.pollDaemonWatchdog(endpoint);
        this.watchdogPoll = tick;
        try {
          await tick;
        } finally {
          if (this.watchdogPoll === tick) this.watchdogPoll = undefined;
        }
      }
    } catch (error) {
      if (!this.watchdogAbort.signal.aborted) throw error;
    }
  }

  async pollDaemonWatchdog(endpoint: BoxEndpoint): Promise<void> {
    const startedAt = this.now();
    const result = await this.options.operations.ping(createContext(), endpoint);
    const endedAt = this.now();
    const target = `${endpoint.host}:${endpoint.port}`;

    if (result.outcome === "ok") {
      if (this.watchdogState === "unready") {
        const outageStartedAt = this.outageStartedAt ?? startedAt;
        this.report({
          outcome: "ok",
          attempts: this.outageAttempts + 1,
          durationMs: endedAt - outageStartedAt,
          unreadyDurationMs: endedAt - outageStartedAt,
          readinessState: "ready_after_retry",
          target,
        });
      }
      this.watchdogState = "ready";
      this.outageStartedAt = undefined;
      this.outageAttempts = 0;
      return;
    }

    if (this.watchdogState === "ready") {
      this.watchdogState = "unready";
      this.outageStartedAt = startedAt;
      this.outageAttempts = 1;
      this.report({
        outcome: result.outcome,
        attempts: 1,
        durationMs: endedAt - startedAt,
        unreadyDurationMs: endedAt - startedAt,
        readinessState: daemonPingReadinessState(result.outcome),
        target,
        ...(result.causeSummary == null ? {} : { causeSummary: result.causeSummary }),
      });
      return;
    }

    this.outageAttempts += 1;
  }

  async dispose(): Promise<void> {
    this.watchdogAbort.abort();
    await this.watchdogRun;
  }

  private now(): number {
    return this.options.operations.now?.() ?? Date.now();
  }

  private async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    const customSleep = this.options.operations.sleep;
    if (customSleep !== undefined) {
      await customSleep(milliseconds, signal);
      return;
    }
    await delay(milliseconds, undefined, signal === undefined ? { ref: false } : { ref: false, signal });
  }

  private report(report: DaemonPingReport): void {
    this.telemetry?.reportDaemonPing(report);
  }
}
