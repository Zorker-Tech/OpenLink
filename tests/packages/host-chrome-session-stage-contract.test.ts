import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createRealRetryPolicy } from "../../source/host/extensions/scheduling.ts";
import { SQLITE_BUSY } from "../../source/host/storage/sqlite-busy.ts";
import {
  CHROME_AUTH_STATE_CACHE_EXCLUDE_NAMES,
  CHROME_AUTH_STATE_REL_DIRS,
  CHROME_SESSION_CATEGORY_NAME,
  CHROME_SESSION_DB_DIR,
  CHROME_SESSION_DB_NAMES,
  CHROME_SESSION_DB_REL_DIR,
  CHROME_SESSION_STAGE_MAX_ATTEMPTS,
  CHROME_SESSION_STAGE_RETRY_DELAY_MS,
  CHROME_SESSION_STAGE_VACUUM_BUSY_TIMEOUT_MS,
  isChromeSessionStageRetryable,
  stageBoxChromeSession,
  vacuumIntoWithRetry,
  type ChromeStageReport,
} from "../../source/host/boxes/box-store-sync/chrome-session-stage.ts";
import type { SqliteSnapshotFailure } from "../../source/host/boxes/box-store-sync/sqlite-snapshot.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-chrome-session-stage-contract-"));
after(() => { rmSync(scratch, { recursive: true, force: true }); });

function retryPolicy(maxAttempts = 1) {
  return createRealRetryPolicy({
    name: `test chrome stage retry ${maxAttempts}`,
    maxAttempts,
    initialDelayMs: 0,
    maxDelayMs: 0,
    shouldRetry: isChromeSessionStageRetryable,
  });
}

function sourceFile(name: string, mode = 0o640): string {
  const path = join(scratch, name);
  writeFileSync(path, `database:${name}`);
  chmodSync(path, mode);
  return path;
}

describe("Chrome session staging behavior contract", () => {
  it("keeps the Chrome paths, files, retry and category bounds explicit", () => {
    assert.equal(CHROME_SESSION_CATEGORY_NAME, "chrome-session");
    assert.equal(CHROME_SESSION_DB_DIR, "/home/box/chrome-profile/Default");
    assert.equal(CHROME_SESSION_DB_REL_DIR, "home/box/chrome-profile/Default");
    assert.deepEqual(CHROME_SESSION_DB_NAMES, ["Cookies", "Login Data", "Login Data For Account", "Web Data"]);
    assert.deepEqual(CHROME_AUTH_STATE_REL_DIRS, ["Local Storage", "Session Storage", "IndexedDB", "Service Worker"]);
    assert.deepEqual(CHROME_AUTH_STATE_CACHE_EXCLUDE_NAMES, ["CacheStorage", "ScriptCache"]);
    assert.equal(CHROME_SESSION_STAGE_MAX_ATTEMPTS, 1);
    assert.equal(CHROME_SESSION_STAGE_RETRY_DELAY_MS, 150);
    assert.equal(CHROME_SESSION_STAGE_VACUUM_BUSY_TIMEOUT_MS, 100);
  });

  it("retries busy and locked failures but not unrelated errors", () => {
    assert.equal(isChromeSessionStageRetryable(new Error("database is locked")), true);
    assert.equal(isChromeSessionStageRetryable("BUSY from sqlite"), true);
    assert.equal(isChromeSessionStageRetryable(new Error("missing file")), false);
  });

  it("cleans the destination before retrying a failed vacuum and preserves the successful snapshot", async () => {
    const input = sourceFile("retry-source.db");
    const output = join(scratch, "retry-copy.db");
    writeFileSync(output, "stale output");
    const preCleanState: boolean[] = [];
    let attempts = 0;
    await vacuumIntoWithRetry(input, output, {
      retry: retryPolicy(2),
      vacuum: (src, dest) => {
        attempts += 1;
        preCleanState.push(existsSync(dest));
        if (attempts === 1) throw Object.assign(new Error("database is locked"), { errcode: SQLITE_BUSY });
        writeFileSync(dest, `snapshot:${readFileSync(src, "utf8")}`);
      },
    });
    assert.equal(attempts, 2);
    assert.deepEqual(preCleanState, [true, false]);
    assert.equal(readFileSync(output, "utf8"), "snapshot:database:retry-source.db");
  });

  it("logs a retry cleanup failure and still runs the retry operation", async () => {
    const input = sourceFile("uncleanable-source.db");
    const output = join(scratch, "uncleanable-output");
    mkdirSync(output);
    const logs: string[] = [];
    let attempts = 0;
    await vacuumIntoWithRetry(input, output, {
      retry: retryPolicy(2),
      log: (message) => logs.push(message),
      vacuum: () => { attempts += 1; if (attempts === 1) throw new Error("locked"); },
    });
    assert.equal(attempts, 2);
    assert.equal(logs.some((message) => message.startsWith("retry pre-clean failed:")), true);
  });

  it("stages existing databases, preserves their mode and reports a successful batch", async () => {
    const source = sourceFile("Cookies", 0o640);
    const reports: ChromeStageReport[] = [];
    const staged = await stageBoxChromeSession({
      retry: retryPolicy(),
      sessionDbDir: scratch,
      sessionDbRelDir: "profile/Default",
      sessionDbNames: ["Missing", "Cookies"],
      report: (report) => reports.push(report),
      vacuum: (src, dest) => writeFileSync(dest, `vacuum:${readFileSync(src, "utf8")}`),
    });
    try {
      assert.equal(staged.skipped, 0);
      assert.deepEqual(staged.files.map(({ relPath }) => relPath), ["profile/Default/Cookies"]);
      assert.equal(staged.files[0]?.mode, 0o640);
      assert.equal(readFileSync(staged.files[0]!.absPath, "utf8"), "vacuum:database:Cookies");
      assert.deepEqual(reports, [{ staged: 1, skipped: 0, skippedDbNames: [], errorClass: null }]);
      assert.equal(statSync(source).mode & 0o777, 0o640);
    } finally {
      await staged.cleanup();
    }
    assert.equal(existsSync(staged.files[0]!.absPath), false);
  });

  it("records stat failures as skipped databases with a structured source-read failure", async () => {
    const reports: ChromeStageReport[] = [];
    const staged = await stageBoxChromeSession({
      retry: retryPolicy(),
      sessionDbDir: scratch,
      sessionDbNames: ["MissingButClaimed"],
      fileExists: () => true,
      report: (report) => reports.push(report),
      log: () => {},
    });
    try {
      assert.equal(staged.files.length, 0);
      assert.equal(staged.skipped, 1);
      assert.deepEqual(reports[0], {
        staged: 0,
        skipped: 1,
        skippedDbNames: ["MissingButClaimed"],
        errorClass: "Error",
      });
    } finally {
      await staged.cleanup();
    }
  });

  it("falls back to a locked-file copy when vacuum reports SQLite busy", async () => {
    const input = sourceFile("busy-Cookies.db", 0o600);
    let copyCalled = false;
    const logs: string[] = [];
    const reports: ChromeStageReport[] = [];
    const staged = await stageBoxChromeSession({
      retry: retryPolicy(),
      sessionDbDir: scratch,
      sessionDbRelDir: "profile",
      sessionDbNames: ["busy-Cookies.db"],
      vacuum: () => { throw Object.assign(new Error("locked"), { errcode: SQLITE_BUSY }); },
      copyLockedDb: ({ srcPath, destPath }) => {
        copyCalled = true;
        writeFileSync(destPath, `copy:${readFileSync(srcPath, "utf8")}`);
        return true;
      },
      log: (message) => logs.push(message),
      report: (report) => reports.push(report),
    });
    try {
      assert.equal(copyCalled, true);
      assert.equal(staged.skipped, 0);
      assert.equal(staged.files[0]?.mode, 0o600);
      assert.equal(readFileSync(staged.files[0]!.absPath, "utf8"), "copy:database:busy-Cookies.db");
      assert.equal(logs.some((message) => message.includes("raw-copy fallback")), true);
      assert.deepEqual(reports[0], { staged: 1, skipped: 0, skippedDbNames: [], errorClass: null });
    } finally {
      await staged.cleanup();
    }
    assert.equal(existsSync(staged.files[0]!.absPath), false);
    assert.equal(existsSync(input), true);
  });

  it("uses raw-copy failure details when the locked database cannot be copied", async () => {
    sourceFile("failed-Cookies.db");
    const reports: ChromeStageReport[] = [];
    const failure: SqliteSnapshotFailure = {
      operation: "verify_source_stability",
      pathStage: "source_main",
      cause: "source_changed",
      errorClass: "none",
    };
    const staged = await stageBoxChromeSession({
      retry: retryPolicy(),
      sessionDbDir: scratch,
      sessionDbNames: ["failed-Cookies.db"],
      vacuum: () => { throw Object.assign(new Error("database is locked"), { errcode: SQLITE_BUSY }); },
      copyLockedDb: ({ onFailure }) => { onFailure?.(failure); return false; },
      log: () => {},
      report: (report) => reports.push(report),
    });
    try {
      assert.equal(staged.skipped, 1);
      assert.deepEqual(reports[0]?.failure, { db: "failed-Cookies.db", phase: "raw_copy", ...failure });
      assert.equal(reports[0]?.errorClass, "none");
    } finally {
      await staged.cleanup();
    }
  });

  it("skips a non-busy vacuum failure without trying the locked-copy fallback", async () => {
    sourceFile("broken-Web-Data.db");
    let copyCalled = false;
    const reports: ChromeStageReport[] = [];
    const staged = await stageBoxChromeSession({
      retry: retryPolicy(),
      sessionDbDir: scratch,
      sessionDbNames: ["broken-Web-Data.db"],
      vacuum: () => { throw new Error("invalid database"); },
      copyLockedDb: () => { copyCalled = true; return true; },
      log: () => {},
      report: (report) => reports.push(report),
    });
    try {
      assert.equal(copyCalled, false);
      assert.equal(staged.skipped, 1);
      assert.equal(reports[0]?.failure?.phase, "vacuum");
      assert.equal(reports[0]?.failure?.cause, "error");
    } finally {
      await staged.cleanup();
    }
  });

  it("does not report an empty staging pass", async () => {
    const reports: ChromeStageReport[] = [];
    const staged = await stageBoxChromeSession({
      retry: retryPolicy(),
      sessionDbDir: scratch,
      sessionDbNames: ["not-present"],
      report: (report) => reports.push(report),
    });
    await staged.cleanup();
    assert.deepEqual(staged.files, []);
    assert.equal(staged.skipped, 0);
    assert.deepEqual(reports, []);
  });
});
