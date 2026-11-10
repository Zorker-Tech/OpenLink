import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { isSqliteBusyError } from "../../storage/sqlite-busy.ts";
import { classifySqliteSnapshotFailure, copyLockedSqliteDb, sqliteVacuumInto, type SqliteSnapshotFailure } from "./sqlite-snapshot.ts";
import { CHROME_SESSION_STAGE_VACUUM_BUSY_TIMEOUT_MS, type ChromeSessionStageDependencies, type StagedChromeFile } from "./chrome-session-stage-contracts.ts";
import { vacuumIntoWithRetry } from "./chrome-session-stage-retry.ts";

export type ChromeDatabaseStageResult =
  | { kind: "missing" }
  | { kind: "staged"; file: StagedChromeFile; copiedAfterLock: boolean }
  | { kind: "skipped"; name: string; errorClass: string; failure?: { db: string; phase: string } & SqliteSnapshotFailure };

export async function stageChromeDatabase(
  deps: ChromeSessionStageDependencies,
  values: {
    sessionDbDir: string;
    sessionDbRelDir: string;
    databaseName: string;
    destinationDirectory: string;
  },
): Promise<ChromeDatabaseStageResult> {
  const { sessionDbDir, sessionDbRelDir, databaseName, destinationDirectory } = values;
  const sourcePath = join(sessionDbDir, databaseName);
  const fileExists = deps.fileExists ?? existsSync;
  if (!fileExists(sourcePath)) return { kind: "missing" };

  let mode: number;
  try {
    mode = (await stat(sourcePath)).mode & 0o777;
  } catch (error) {
    const classified = classifySqliteSnapshotFailure(error, "read_source_main", "source_main");
    (deps.log ?? ((message: string) => console.log(`[chrome-session-stage] ${message}`)))(
      `stage skipped ${databaseName} because its mode could not be read: ${String(error)}`,
    );
    return { kind: "skipped", name: databaseName, errorClass: classified.errorClass };
  }

  const destinationPath = join(destinationDirectory, databaseName);
  const vacuum = deps.vacuum ?? ((source: string, destination: string) => sqliteVacuumInto(source, destination, CHROME_SESSION_STAGE_VACUUM_BUSY_TIMEOUT_MS));
  const copyLocked = deps.copyLockedDb ?? copyLockedSqliteDb;
  try {
    await vacuumIntoWithRetry(sourcePath, destinationPath, {
      retry: deps.retry,
      vacuum,
      ...(deps.log === undefined ? {} : { log: deps.log }),
    });
    return {
      kind: "staged",
      file: { relPath: `${sessionDbRelDir}/${databaseName}`, absPath: destinationPath, mode },
      copiedAfterLock: false,
    };
  } catch (error) {
    let failure: { db: string; phase: string } & SqliteSnapshotFailure = {
      db: databaseName,
      phase: "vacuum",
      ...classifySqliteSnapshotFailure(error, "vacuum_into", "source_or_staged_main"),
    };
    if (isSqliteBusyError(error)) {
      let copyFailure: ReturnType<typeof classifySqliteSnapshotFailure> | undefined;
      const copied = copyLocked({
        srcPath: sourcePath,
        destPath: destinationPath,
        onFailure: (value) => { copyFailure = value; },
      });
      if (copied) {
        return {
          kind: "staged",
          file: { relPath: `${sessionDbRelDir}/${databaseName}`, absPath: destinationPath, mode },
          copiedAfterLock: true,
        };
      }
      if (copyFailure !== undefined) failure = { db: databaseName, phase: "raw_copy", ...copyFailure };
    }
    (deps.log ?? ((message: string) => console.log(`[chrome-session-stage] ${message}`)))(
      `stage skipped ${databaseName} after retries: ${String(error)}`,
    );
    return { kind: "skipped", name: databaseName, errorClass: failure.errorClass, failure };
  }
}
