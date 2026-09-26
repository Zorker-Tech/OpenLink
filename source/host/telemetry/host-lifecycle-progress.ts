/**
 * How far the host got in starting up.
 *
 * Each phase is reported once with what it completed — plugins, boxes, agents — and the phases the platform walks
 * through are the same ones the host's own ports name.
 */
import {
  SlateError,
  type SlateErrorValue,
} from "../../shared/errors/registry.ts";
import { SLATE_HOST_LIFECYCLE_PHASES } from "../ports/telemetry.ts";
export { SLATE_HOST_LIFECYCLE_PHASES };
export interface Disposable {
  dispose(): void;
}
export interface HostLifecycleCompletion {
  phase: string;
  pluginCount?: number;
  entryCount?: number;
}
export type HostLifecycleReport =
  | (HostLifecycleCompletion & {
      outcome: "completed";
      durationMs: number;
    })
  | {
      phase: string;
      outcome: "failed" | "stuck";
      durationMs: number;
      error: SlateErrorValue;
    };
export class HostLifecycleProgress {
  private phaseIndex = 0;
  private phaseStartedAt: number;
  private watchdogHandle: Disposable | undefined;
  constructor(
    private readonly options: {
      startedAt: number;
      now(): number;
      report(report: HostLifecycleReport): void;
      watchdog: { arm(listener: () => void): Disposable };
    },
  ) {
    this.phaseStartedAt = options.startedAt;
    this.armWatchdog();
  }
  complete(completion: HostLifecycleCompletion): void {
    const phase = this.currentPhase();
    if (phase !== completion.phase)
      throw new Error(
        `Host lifecycle phase ${completion.phase} completed while ${phase ?? "none"} was active`,
      );
    this.watchdogHandle?.dispose();
    this.watchdogHandle = undefined;
    this.options.report({
      ...completion,
      outcome: "completed",
      durationMs: this.elapsedMs(),
    });
    this.phaseIndex += 1;
    this.phaseStartedAt = this.options.now();
    this.armWatchdog();
  }
  fail(): void {
    const phase = this.currentPhase();
    if (phase === undefined) return;
    this.watchdogHandle?.dispose();
    this.watchdogHandle = undefined;
    this.options.report({
      phase,
      outcome: "failed",
      durationMs: this.elapsedMs(),
      error: SlateError.hostLifecycleFailed(),
    });
  }
  armWatchdog(): void {
    const phase = this.currentPhase();
    if (phase === undefined) return;
    this.watchdogHandle = this.options.watchdog.arm(() =>
      this.options.report({
        phase,
        outcome: "stuck",
        durationMs: this.elapsedMs(),
        error: SlateError.hostLifecycleStalled(),
      }),
    );
  }
  currentPhase(): string | undefined {
    return SLATE_HOST_LIFECYCLE_PHASES[this.phaseIndex];
  }
  elapsedMs(): number {
    return Math.max(0, Math.round(this.options.now() - this.phaseStartedAt));
  }
}
