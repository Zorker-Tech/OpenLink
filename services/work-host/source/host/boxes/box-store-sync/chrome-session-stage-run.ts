import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHROME_SESSION_DB_DIR,
  CHROME_SESSION_DB_NAMES,
  CHROME_SESSION_DB_REL_DIR,
  type ChromeSessionStageDependencies,
  type ChromeSessionStageResult,
  type ChromeStageReport,
  type StagedChromeFile,
} from "./chrome-session-stage-contracts.ts";
import { stageChromeDatabase } from "./chrome-session-stage-file.ts";

export async function stageBoxChromeSession(
  deps: ChromeSessionStageDependencies,
): Promise<ChromeSessionStageResult> {
  const sourceDirectory = deps.sessionDbDir ?? CHROME_SESSION_DB_DIR;
  const relativeDirectory = deps.sessionDbRelDir ?? CHROME_SESSION_DB_REL_DIR;
  const databaseNames = deps.sessionDbNames ?? CHROME_SESSION_DB_NAMES;
  const fileExists = deps.fileExists ?? existsSync;
  const log = deps.log ?? ((message: string) => console.log(`[chrome-session-stage] ${message}`));
  const stagingDirectory = await mkdtemp(join(tmpdir(), "slate-chrome-session-"));
  const stagedFiles: StagedChromeFile[] = [];
  const skippedDatabaseNames: string[] = [];
  const rawCopiedDatabaseNames: string[] = [];
  let lastErrorClass: string | null = null;
  let lastFailure: ChromeStageReport["failure"];

  for (const databaseName of databaseNames) {
    const result = await stageChromeDatabase({ ...deps, fileExists, log }, {
      sessionDbDir: sourceDirectory,
      sessionDbRelDir: relativeDirectory,
      databaseName,
      destinationDirectory: stagingDirectory,
    });
    if (result.kind === "missing") continue;
    if (result.kind === "staged") {
      stagedFiles.push(result.file);
      if (result.copiedAfterLock) rawCopiedDatabaseNames.push(databaseName);
      continue;
    }

    skippedDatabaseNames.push(result.name);
    lastErrorClass = result.errorClass;
    if (result.failure !== undefined) lastFailure = result.failure;
  }

  if (rawCopiedDatabaseNames.length > 0) {
    log(`staged ${rawCopiedDatabaseNames.length} exclusively-locked db(s) via raw-copy fallback: ${rawCopiedDatabaseNames.join(", ")}`);
  }
  if (deps.report !== undefined && (stagedFiles.length > 0 || skippedDatabaseNames.length > 0)) {
    deps.report({
      staged: stagedFiles.length,
      skipped: skippedDatabaseNames.length,
      skippedDbNames: skippedDatabaseNames,
      errorClass: lastErrorClass,
      ...(lastFailure === undefined ? {} : { failure: lastFailure }),
    });
  }

  return {
    files: stagedFiles,
    skipped: skippedDatabaseNames.length,
    cleanup: async () => rm(stagingDirectory, { recursive: true, force: true }),
  };
}
