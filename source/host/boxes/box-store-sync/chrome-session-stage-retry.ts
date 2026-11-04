import { promises as fs } from "node:fs";

import { sqliteVacuumInto } from "./sqlite-snapshot.ts";
import type { ChromeSessionStageDependencies } from "./chrome-session-stage-contracts.ts";

export function isChromeSessionStageRetryable(error: unknown): boolean {
  return /busy|locked/i.test(String(error));
}

export async function vacuumIntoWithRetry(
  sourcePath: string,
  snapshotPath: string,
  deps: Pick<ChromeSessionStageDependencies, "retry" | "vacuum" | "log">,
): Promise<void> {
  const runVacuum = deps.vacuum ?? sqliteVacuumInto;
  const writeLog = deps.log ?? ((message: string) => console.log(`[chrome-session-stage] ${message}`));
  await deps.retry.runWithRetry(async (attempt) => {
    if (attempt > 1) {
      await fs.rm(snapshotPath, { force: true }).catch((error) => {
        writeLog(`retry pre-clean failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    runVacuum(sourcePath, snapshotPath);
  });
}
