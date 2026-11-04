import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import {
  acquireHostLock,
  defaultIsProcessAlive,
  MAX_ACQUIRE_ATTEMPTS,
  readLockPid,
} from "../../source/host/host-lock.ts";

function lockFixture() {
  const directory = mkdtempSync(join(tmpdir(), "slate-host-lock-contract-"));
  const path = join(directory, "nested", "host.lock");
  mkdirSync(join(directory, "nested"), { recursive: true });
  return {
    path,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

describe("the host process lock", () => {
  it("reads only a usable positive process id and reports malformed files as absent", () => {
    const fixture = lockFixture();
    try {
      writeFileSync(fixture.path, " 4242\n", "utf8");
      assert.equal(readLockPid(fixture.path), 4242);
      writeFileSync(fixture.path, "not a pid", "utf8");
      assert.equal(readLockPid(fixture.path), null);
      writeFileSync(fixture.path, "0", "utf8");
      assert.equal(readLockPid(fixture.path), null);
      assert.equal(readLockPid(join(fixture.path, "missing")), null);
      assert.equal(defaultIsProcessAlive(process.pid), true);
      assert.equal(defaultIsProcessAlive(Number.MAX_SAFE_INTEGER), false);
    } finally {
      fixture.dispose();
    }
  });

  it("creates the parent directory and releases only the pid still recorded in the file", async () => {
    const fixture = lockFixture();
    try {
      rmSync(join(fixture.path, ".."), { recursive: true, force: true });
      const created = await acquireHostLock({ path: fixture.path, pid: 101 });
      assert.deepEqual([created.outcome, created.previousPid], ["created", undefined]);
      assert.equal(readLockPid(fixture.path), 101);

      writeFileSync(fixture.path, "202", "utf8");
      created.lock.release();
      assert.equal(readLockPid(fixture.path), 202, "an old handle cannot release a replacement owner's lock");

      writeFileSync(fixture.path, "101", "utf8");
      created.lock.release();
      assert.equal(existsSync(fixture.path), false);
    } finally {
      fixture.dispose();
    }
  });

  it("reclaims malformed and dead-owner files before recording its own pid", async () => {
    const fixture = lockFixture();
    try {
      writeFileSync(fixture.path, "broken", "utf8");
      const malformed = await acquireHostLock({ path: fixture.path, pid: 303 });
      assert.deepEqual([malformed.outcome, malformed.previousPid], ["reclaimed-dead", undefined]);
      assert.equal(readLockPid(fixture.path), 303);
      malformed.lock.release();

      writeFileSync(fixture.path, "404", "utf8");
      const dead = await acquireHostLock({
        path: fixture.path,
        pid: 505,
        isProcessAlive: () => false,
        terminateProcess: () => assert.fail("a dead owner is not signalled"),
      });
      assert.deepEqual([dead.outcome, dead.previousPid], ["reclaimed-dead", 404]);
      assert.equal(readLockPid(fixture.path), 505);
      dead.lock.release();
    } finally {
      fixture.dispose();
    }
  });

  it("replaces a live foreign pid without sending it host shutdown signals", async () => {
    const fixture = lockFixture();
    const signals: NodeJS.Signals[] = [];
    try {
      writeFileSync(fixture.path, "606", "utf8");
      const lock = await acquireHostLock({
        path: fixture.path,
        pid: 707,
        isProcessAlive: () => true,
        isSlateHostProcess: () => false,
        terminateProcess: (_pid, signal) => signals.push(signal),
      });
      assert.deepEqual([lock.outcome, lock.previousPid], ["reclaimed-foreign", 606]);
      assert.deepEqual(signals, []);
      assert.equal(readLockPid(fixture.path), 707);
      lock.lock.release();
    } finally {
      fixture.dispose();
    }
  });

  it("asks a live Slate host to exit gracefully, then forces it down only if needed", async () => {
    const fixture = lockFixture();
    try {
      writeFileSync(fixture.path, "808", "utf8");
      let alive = true;
      const gracefulSignals: NodeJS.Signals[] = [];
      const graceful = await acquireHostLock({
        path: fixture.path,
        pid: 909,
        isProcessAlive: () => alive,
        isSlateHostProcess: () => true,
        terminateProcess: (_pid, signal) => {
          gracefulSignals.push(signal);
          alive = false;
        },
        delay: async () => {},
      });
      assert.deepEqual([graceful.outcome, graceful.previousPid], ["took-over", 808]);
      assert.deepEqual(gracefulSignals, ["SIGTERM"]);
      assert.equal(readLockPid(fixture.path), 909);
      graceful.lock.release();

      writeFileSync(fixture.path, "1001", "utf8");
      alive = true;
      const forcedSignals: NodeJS.Signals[] = [];
      const forced = await acquireHostLock({
        path: fixture.path,
        pid: 1002,
        isProcessAlive: () => alive,
        isSlateHostProcess: () => true,
        terminateProcess: (_pid, signal) => {
          forcedSignals.push(signal);
          if (signal === "SIGKILL") alive = false;
        },
        delay: async () => {},
        takeoverTimeoutMs: 0,
      });
      assert.deepEqual([forced.outcome, forced.previousPid], ["took-over", 1001]);
      assert.deepEqual(forcedSignals, ["SIGTERM", "SIGKILL"]);
      assert.equal(readFileSync(fixture.path, "utf8"), "1002");
      forced.lock.release();
    } finally {
      fixture.dispose();
    }
  });

  it("fails closed when exclusive creation keeps losing a race", async () => {
    const fixture = lockFixture();
    let attempts = 0;
    const signals: NodeJS.Signals[] = [];
    try {
      await assert.rejects(() => acquireHostLock({
        path: fixture.path,
        pid: 1103,
        createExclusiveFile: (path) => {
          attempts += 1;
          writeFileSync(path, "1102", "utf8");
          return false;
        },
        isProcessAlive: () => true,
        isSlateHostProcess: () => true,
        terminateProcess: (_pid, signal) => signals.push(signal),
        delay: async () => {},
        takeoverTimeoutMs: 0,
      }), /Could not acquire the Slate host lock/);
      assert.equal(attempts, MAX_ACQUIRE_ATTEMPTS);
      assert.equal(existsSync(fixture.path), false, "the failed acquisition must not overwrite a lock by writing non-exclusively");
      assert.equal(signals.length, MAX_ACQUIRE_ATTEMPTS * 2);
    } finally {
      fixture.dispose();
    }
  });
});
