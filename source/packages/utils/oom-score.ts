/**
 * Undoing an inherited OOM score adjustment for a child process.
 *
 * A parent that is protected from the OOM killer (or the reverse) passes its adjustment on to
 * everything it spawns, and a long-lived agent process inheriting "kill me first" is a process that
 * dies before the work it was doing is finished. Only Linux exposes the knob, and a failure to write
 * it is not worth interrupting the caller for.
 */

import { writeFileSync } from "node:fs"

export function resetChildOomScoreAdj(pid: number | undefined): void {
  if (process.platform !== "linux" || pid === undefined || pid <= 0) return
  try {
    writeFileSync(`/proc/${pid}/oom_score_adj`, "0")
  } catch {
    // The process may already be gone, or the knob may be read-only here.
  }
}
