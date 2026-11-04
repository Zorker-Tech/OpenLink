/**
 * How far the host got in starting up.
 *
 * Each phase is reported once with what it completed — plugins, boxes, agents — and the phases the platform walks
 * through are the same ones the host's own ports name.
 */
import { SLATE_HOST_LIFECYCLE_PHASES } from "../ports/telemetry.ts";
import {
  completedPhaseReport,
  interruptedPhaseReport,
} from "./host-lifecycle-report-policy.ts";
import type {
  CompletedStartupPhase,
  LifecycleTimerHandle,
  StartupPhaseReport,
  StartupProgressPorts,
} from "./host-lifecycle-contracts.ts";

export { SLATE_HOST_LIFECYCLE_PHASES };
export type { StartupPhaseReport } from "./host-lifecycle-contracts.ts";

export class HostStartupProgress {
  private phaseIndex = 0;
  private phaseStartedAt: number;
  private watchdogHandle: LifecycleTimerHandle | undefined;

  constructor(private readonly ports: StartupProgressPorts) {
    this.phaseStartedAt = ports.startedAt;
    this.armPhaseWatchdog();
  }

  complete(completion: CompletedStartupPhase): void {
    const phase = this.activePhase();
    if (phase !== completion.phase) {
      throw new Error(`Startup phase ${completion.phase} cannot finish while ${phase ?? "none"} is active`);
    }
    this.watchdogHandle?.dispose();
    this.watchdogHandle = undefined;
    this.ports.report(completedPhaseReport(completion, this.elapsedMilliseconds()));
    this.phaseIndex += 1;
    this.phaseStartedAt = this.ports.now();
    this.armPhaseWatchdog();
  }

  fail(): void {
    const phase = this.activePhase();
    if (phase === undefined) return;
    this.watchdogHandle?.dispose();
    this.watchdogHandle = undefined;
    this.ports.report(interruptedPhaseReport(phase, this.elapsedMilliseconds(), "failed"));
  }

  armPhaseWatchdog(): void {
    const phase = this.activePhase();
    if (phase === undefined) return;
    this.watchdogHandle = this.ports.watchdog.arm(() =>
      this.ports.report(interruptedPhaseReport(phase, this.elapsedMilliseconds(), "stuck")),
    );
  }

  activePhase(): string | undefined {
    return SLATE_HOST_LIFECYCLE_PHASES[this.phaseIndex];
  }

  elapsedMilliseconds(): number {
    return Math.max(0, Math.round(this.ports.now() - this.phaseStartedAt));
  }
}
