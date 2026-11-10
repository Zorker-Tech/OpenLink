import type { SlateErrorValue } from "../../shared/errors/registry.ts";

export interface LifecycleTimerHandle {
  dispose(): void;
}

export interface CompletedStartupPhase {
  readonly phase: string;
  readonly pluginCount?: number;
  readonly entryCount?: number;
}

export type StartupPhaseReport =
  | (CompletedStartupPhase & { readonly outcome: "completed"; readonly durationMs: number })
  | {
      readonly phase: string;
      readonly outcome: "failed" | "stuck";
      readonly durationMs: number;
      readonly error: SlateErrorValue;
    };

export interface StartupProgressPorts {
  readonly startedAt: number;
  readonly now: () => number;
  readonly report: (report: StartupPhaseReport) => void;
  readonly watchdog: { arm(listener: () => void): LifecycleTimerHandle };
}
