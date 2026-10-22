/**
 * Undoing an inherited OOM score adjustment for a child process.
 *
 * A parent that is protected from the OOM killer (or the reverse) passes its adjustment on to everything it spawns,
 * and a long-lived agent process inheriting "kill me first" is a process that dies before the work it was doing is
 * finished. Only Linux exposes the knob, and a failure to write it is not worth interrupting the caller for.
 */
import { writeFileSync } from "node:fs";

/** The Linux knob that carries a process's OOM score, written by pid. */
function oomScoreAdjPath(childPid: number): string {
  return `/proc/${childPid}/oom_score_adj`;
}

/** The score a child starts with: zero, so the parent's protection is not inherited. */
const NEUTRAL_OOM_SCORE_ADJ = "0";

/** Resets a child's inherited OOM score, on Linux only, without disturbing the caller when it cannot. */
export function resetChildOomScoreAdj(childPid: number | undefined): void {
  if (process.platform !== "linux" || childPid === undefined || childPid <= 0) return;
  try {
    writeFileSync(oomScoreAdjPath(childPid), NEUTRAL_OOM_SCORE_ADJ);
  } catch {
    // The process may already be gone, or the knob may be read-only here.
  }
}
