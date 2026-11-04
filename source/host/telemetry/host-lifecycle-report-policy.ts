import { SlateError } from "../../shared/errors/registry.ts";
import type {
  CompletedStartupPhase,
  StartupPhaseReport,
} from "./host-lifecycle-contracts.ts";

export function completedPhaseReport(
  completion: CompletedStartupPhase,
  durationMs: number,
): StartupPhaseReport {
  return { ...completion, outcome: "completed", durationMs };
}

export function interruptedPhaseReport(
  phase: string,
  durationMs: number,
  cause: "failed" | "stuck",
): StartupPhaseReport {
  return {
    phase,
    outcome: cause,
    durationMs,
    error: cause === "failed"
      ? SlateError.hostLifecycleFailed()
      : SlateError.hostLifecycleStalled(),
  };
}
