import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";

import {
  STORE_LOCK_MTIME_UPDATE_MS,
  STORE_LOCK_STALE_MS,
  StoreLockError,
  getCurrentStoreLockIdentity,
  readActiveStoreLockOwner,
  tryAcquireStoreLock,
} from "../../source/packages/agent-store-sync/store-lock.ts";

// ---------------------------------------------------------------------------------------------
// harness: a scripted lockfile filesystem in a real temporary directory
// ---------------------------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
const IDENTITY = { uid: 501, sid: undefined };
const HOST = "test-host";
const PID = 4242;

const enoent = () => Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
const eexist = () => Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });

const ownerJson = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  uid: IDENTITY.uid, sid: IDENTITY.sid, pid: PID, hostname: HOST, windowId: "window-1", acquiredAt: NOW, ...overrides,
});

interface Script {
  readFile?: () => Promise<string>;
  stat?: () => Promise<{ mtimeMs: number }>;
  unlink?: () => Promise<void>;
  utimes?: () => Promise<void>;
  writeLockExclusive?: () => Promise<void>;
}

function fakeFs(script: Script = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  return {
    calls,
    fs: {
      readFile: async (targetPath: string, encoding: string) => { calls.push(["readFile", targetPath, encoding]); return script.readFile ? await script.readFile() : Promise.reject(enoent()); },
      stat: async (targetPath: string) => { calls.push(["stat", targetPath]); return script.stat ? await script.stat() : Promise.reject(enoent()); },
      unlink: async (targetPath: string) => { calls.push(["unlink", targetPath]); return script.unlink ? await script.unlink() : undefined; },
      utimes: async (targetPath: string, atime: Date, mtime: Date) => { calls.push(["utimes", targetPath, atime, mtime]); return script.utimes ? await script.utimes() : undefined; },
      writeLockExclusive: async (targetPath: string, data: string, mode: number) => { calls.push(["writeLockExclusive", targetPath, data, mode]); return script.writeLockExclusive ? await script.writeLockExclusive() : undefined; },
    },
  };
}

const workspace = () => mkdtempSync(join(realpathSync(tmpdir()), "store-lock-test-"));

async function acquire(script: Script, options: Record<string, unknown> = {}) {
  const { fs, calls } = fakeFs(script);
  const root = workspace();
  const outcome = await tryAcquireStoreLock({
    lockPath: join(root, "nested", ".agent-store-lock"),
    windowId: "window-1",
    identity: IDENTITY,
    hostname: HOST,
    now: () => NOW,
    pid: PID,
    processExists: (pid: number) => pid === PID,
    staleLockMs: 10_000,
    staleRecheckDelayMs: 0,
    mtimeUpdateMs: 0,
    fs: fs as never,
    ...options,
  } as never);
  return { outcome, calls, root, fs };
}

// ---------------------------------------------------------------------------------------------
// constants, errors and identity
// ---------------------------------------------------------------------------------------------

describe("the store lock's values and refusals", () => {
  it("knows how often it refreshes and when it is stale", () => {
    assert.deepEqual([STORE_LOCK_MTIME_UPDATE_MS, STORE_LOCK_STALE_MS], [1_000, 600_000]);
  });

  it("carries the reason and the lockfile in its refusal", () => {
    const error = new StoreLockError({ code: "invalid_lockfile", message: "bad file", lockPath: "/store/.lock" });
    assert.equal(error instanceof Error, true);
    assert.deepEqual([error.name, error.message, error.code, error.lockPath], ["StoreLockError", "bad file", "invalid_lockfile", "/store/.lock"]);
  });

  it("names the current identity, and knows a missing one", () => {
    const identity = getCurrentStoreLockIdentity();
    assert.equal(typeof identity.uid, "number");
    assert.equal(identity.sid, undefined);
  });
});

// ---------------------------------------------------------------------------------------------
// taking a lock
// ---------------------------------------------------------------------------------------------

describe("taking a store lock", () => {
  it("creates the lockfile privately, with who took it and when", async () => {
    const { outcome, calls, root } = await acquire({});
    try {
      assert.equal((outcome as { kind: string }).kind, "acquired");
      const write = calls.find(call => call[0] === "writeLockExclusive");
      assert.notEqual(write, undefined);
      assert.equal(write?.[3], 0o600, "the lockfile is private");
      assert.deepEqual(JSON.parse(String(write?.[2])), { uid: 501, pid: PID, hostname: HOST, windowId: "window-1", acquiredAt: NOW });
      assert.equal(calls[0]?.[0], "writeLockExclusive", "nothing is read before the attempt");
      assert.equal(existsSync(join(root, "nested")), true, "the lockfile's directory chain is created");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fills defaults from the process when the caller leaves them out", async () => {
    const { outcome, calls } = await acquire({}, { identity: undefined, hostname: undefined, pid: undefined, processExists: undefined });
    assert.equal((outcome as { kind: string }).kind, "acquired");
    const written = JSON.parse(String(calls.find(call => call[0] === "writeLockExclusive")?.[2])) as Record<string, unknown>;
    assert.equal(typeof written.uid, "number");
    assert.equal(written.pid, process.pid);
    assert.equal(typeof written.hostname, "string");
    assert.equal(written.windowId, "window-1");
  });

  it("says who holds a live lock instead of taking it", async () => {
    const { outcome } = await acquire({ writeLockExclusive: async () => { throw eexist(); }, readFile: async () => ownerJson(), stat: async () => ({ mtimeMs: NOW - 100 }) });
    assert.deepEqual(outcome, { kind: "held", owner: { uid: 501, sid: undefined, pid: PID, hostname: HOST, windowId: "window-1", acquiredAt: NOW } });
  });

  it("refuses a lock held by another operating-system identity", async () => {
    for (const [label, owner, expected] of [
      ["uid", ownerJson({ uid: 999 }), /held by uid 999, expected 501/],
      ["sid", ownerJson({ sid: "S-1-OTHER" }), /held by sid S-1-OTHER, expected S-1-5-21/],
    ] as Array<[string, string, RegExp]>) {
      await assert.rejects(
        () => acquire({ writeLockExclusive: async () => { throw eexist(); }, readFile: async () => owner, stat: async () => ({ mtimeMs: NOW - 100 }) }, { identity: { uid: 501, sid: "S-1-5-21" } }),
        (error: unknown) => error instanceof StoreLockError && error.code === "foreign_identity_lock" && expected.test(error.message),
        label,
      );
    }
  });

  /** A writer that loses the first race and wins the retry, which is what a takeover looks like. */
  function contendedWriter() {
    let writes = 0;
    return async () => { writes += 1; if (writes === 1) throw eexist(); };
  }

  it("takes over a lock whose holder is gone, or one that has not been refreshed", async () => {
    const dead = await acquire({ writeLockExclusive: contendedWriter(), readFile: async () => ownerJson({ pid: 111 }), stat: async () => ({ mtimeMs: NOW - 100 }) });
    assert.equal((dead.outcome as { kind: string }).kind, "acquired");
    assert.equal(dead.calls.filter(call => call[0] === "unlink").length, 1, "the stale lockfile is removed before the retry");

    const stale = await acquire({ writeLockExclusive: contendedWriter(), readFile: async () => ownerJson(), stat: async () => ({ mtimeMs: NOW - 50_000 }) });
    assert.equal((stale.outcome as { kind: string }).kind, "acquired");

    // A stale lock that turns out to be fresh on the recheck is respected.
    let stats = 0;
    const reread = await acquire({ writeLockExclusive: async () => { throw eexist(); }, readFile: async () => ownerJson(), stat: async () => { stats += 1; return { mtimeMs: stats === 1 ? NOW - 50_000 : NOW - 100 }; } });
    assert.equal((reread.outcome as { kind: string }).kind, "held");
  });

  it("retries once when a stale lockfile disappears under it, and answers honestly when the retry loses", async () => {
    let writes = 0;
    let reads = 0;
    const { outcome } = await acquire({
      writeLockExclusive: async () => { writes += 1; if (writes === 1) throw eexist(); },
      readFile: async () => { reads += 1; if (reads === 1) return ownerJson(); throw enoent(); },
      stat: async () => ({ mtimeMs: NOW - 50_000 }),
    });
    assert.equal((outcome as { kind: string }).kind, "acquired");
    assert.deepEqual([writes, reads], [2, 1]);
  });

  it("answers honestly when the retry after a disappearance also loses", async () => {
    let writes = 0;
    const { outcome, calls } = await acquire({
      writeLockExclusive: async () => { writes += 1; throw eexist(); },
      readFile: async () => Promise.reject(enoent()),
      stat: async () => ({ mtimeMs: NOW - 100 }),
    });
    assert.deepEqual(outcome, { kind: "held", owner: undefined });
    assert.deepEqual([writes, calls.filter(call => call[0] === "unlink").length], [2, 1]);
  });

  it("takes over a lockfile it cannot read or understand", async () => {
    const contended = () => { let writes = 0; return async () => { writes += 1; if (writes === 1) throw eexist(); }; };
    const unreadable = await acquire({ writeLockExclusive: contended(), readFile: async () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })) });
    assert.equal((unreadable.outcome as { kind: string }).kind, "acquired");
    const invalid = await acquire({ writeLockExclusive: contended(), readFile: async () => "{not json" });
    assert.equal((invalid.outcome as { kind: string }).kind, "acquired");
    const nonsense = await acquire({ writeLockExclusive: contended(), readFile: async () => JSON.stringify({ pid: "nope" }) });
    assert.equal((nonsense.outcome as { kind: string }).kind, "acquired");
    const wrongTypes = await acquire({ writeLockExclusive: contended(), readFile: async () => JSON.stringify({ pid: 1, hostname: HOST, windowId: "w", acquiredAt: NOW, uid: "not-a-number" }) });
    assert.equal((wrongTypes.outcome as { kind: string }).kind, "acquired");
  });

  it("raises a write failure that is not a lost race, and a refusal to follow a symlinked lockfile", async () => {
    await assert.rejects(() => acquire({ writeLockExclusive: async () => { throw Object.assign(new Error("disk"), { code: "EIO" }); } }), { message: "disk" });
    await assert.rejects(() => acquire({ writeLockExclusive: async () => { throw "boom"; } }));
    const root = workspace();
    try {
      const target = join(root, "real-lock");
      symlinkSync("/nonexistent-target", target);
      await assert.rejects(() => tryAcquireStoreLock({ lockPath: target, windowId: "w", identity: IDENTITY, fs: fakeFs().fs as never } as never));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// what a held lock does
// ---------------------------------------------------------------------------------------------

describe("a held lock", () => {
  async function held(script: Script, options: Record<string, unknown> = {}) {
    const acquired = await acquire(script, options);
    return { lock: (acquired.outcome as unknown as { lock: any }).lock, calls: acquired.calls, fs: acquired.fs, root: acquired.root };
  }

  it("verifies it is still the one in the lockfile, and releases it only when it is", async () => {
    const ours = await held({ readFile: async () => ownerJson() });
    try {
      assert.equal(await ours.lock.verifyStillOwned(), true);
      ours.calls.length = 0;
      await ours.lock.dispose();
      assert.deepEqual(ours.calls.map(call => call[0]), ["readFile", "unlink"]);
      ours.calls.length = 0;
      await ours.lock.dispose();
      assert.deepEqual(ours.calls, [], "disposing twice touches nothing the second time");
      assert.equal(await ours.lock.verifyStillOwned(), false);
    } finally {
      rmSync(ours.root, { recursive: true, force: true });
    }
    const others = await held({ readFile: async () => ownerJson({ windowId: "other" }) });
    try {
      assert.equal(await others.lock.verifyStillOwned(), false);
      others.calls.length = 0;
      await others.lock.dispose();
      assert.equal(others.calls.some(call => call[0] === "unlink"), false, "someone else's lockfile is not unlinked");
    } finally {
      rmSync(others.root, { recursive: true, force: true });
    }
  });

  it("refreshes the lockfile's modification time while it still owns it", async () => {
    const { lock, calls, root } = await held({ readFile: async () => ownerJson() });
    try {
      calls.length = 0;
      await lock.refreshMtime();
      assert.deepEqual(calls.map(call => call[0]), ["readFile", "utimes"]);
      const utimes = calls.find(call => call[0] === "utimes");
      assert.equal((utimes?.[2] as Date).toISOString(), new Date(NOW).toISOString());
      assert.equal((utimes?.[3] as Date).toISOString(), new Date(NOW).toISOString());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops refreshing once it is unhealthy or released, or when the lockfile is no longer ours", async () => {
    const unhealthy = await held({ readFile: async () => ownerJson() });
    try {
      unhealthy.lock.markUnhealthy();
      unhealthy.calls.length = 0;
      await unhealthy.lock.refreshMtime();
      assert.deepEqual(unhealthy.calls, []);
    } finally {
      rmSync(unhealthy.root, { recursive: true, force: true });
    }
    const released = await held({ readFile: async () => ownerJson() });
    try {
      await released.lock.dispose();
      released.calls.length = 0;
      await released.lock.refreshMtime();
      assert.deepEqual(released.calls, [], "a released lock does not refresh");
    } finally {
      rmSync(released.root, { recursive: true, force: true });
    }
    const changed = await held({ readFile: async () => ownerJson({ acquiredAt: NOW - 1 }) });
    try {
      changed.calls.length = 0;
      await changed.lock.refreshMtime();
      assert.deepEqual(changed.calls.map(call => call[0]), ["readFile"], "no utimes after the lock changed hands");
    } finally {
      rmSync(changed.root, { recursive: true, force: true });
    }
  });

  it("keeps a heartbeat that refreshes on its interval and stops when a refresh fails", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const healthy = await held({ readFile: async () => ownerJson() }, { mtimeUpdateMs: 5_000 });
      try {
        healthy.calls.length = 0;
        mock.timers.tick(5_000);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(healthy.calls.map(call => call[0]), ["readFile", "utimes"], "one interval refreshed the lock");
        healthy.calls.length = 0;
        mock.timers.tick(5_000);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(healthy.calls.map(call => call[0]), ["readFile", "utimes"], "the heartbeat keeps refreshing");
      } finally {
        rmSync(healthy.root, { recursive: true, force: true });
      }
      let reads = 0;
      const failing = await held({ readFile: async () => { reads += 1; if (reads === 1) throw Object.assign(new Error("io"), { code: "EIO" }); return ownerJson(); } }, { mtimeUpdateMs: 5_000 });
      try {
        failing.calls.length = 0;
        mock.timers.tick(5_000);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(failing.calls.map(call => call[0]), ["readFile"], "the failed refresh was not worked around");
        failing.calls.length = 0;
        mock.timers.tick(5_000);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(failing.calls, [], "a failed refresh stops the heartbeat");
      } finally {
        rmSync(failing.root, { recursive: true, force: true });
      }
    } finally {
      mock.timers.reset();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// reading who holds a lock
// ---------------------------------------------------------------------------------------------

describe("reading who holds a store lock", () => {
  async function readActive(script: Script & { processExists?: (pid: number) => boolean }, options: Record<string, unknown> = {}) {
    const { fs, calls } = fakeFs(script);
    const outcome = await (async () => {
      try {
        return { ok: true, value: await readActiveStoreLockOwner({ lockPath: join(workspace(), ".lock"), identity: IDENTITY, hostname: HOST, now: () => NOW, pid: PID, processExists: script.processExists ?? (() => true), staleLockMs: 10_000, fs: fs as never, ...options } as never) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? { name: error.name, message: error.message } : String(error) };
      }
    })();
    return { outcome, calls };
  }

  it("answers with the owner when it is this identity, alive and fresh", async () => {
    const { outcome } = await readActive({ readFile: async () => ownerJson(), stat: async () => ({ mtimeMs: NOW - 100 }) });
    assert.deepEqual(outcome, { ok: true, value: { uid: 501, sid: undefined, pid: PID, hostname: HOST, windowId: "window-1", acquiredAt: NOW } });
  });

  it("answers nothing when the lock is gone, dead, stale, foreign or changed mid-read", async () => {
    const cases: Array<[string, Script & { processExists?: (pid: number) => boolean }, unknown]> = [
      ["missing", {}, { ok: true, value: undefined }],
      ["dead", { readFile: async () => ownerJson(), stat: async () => ({ mtimeMs: NOW - 100 }), processExists: () => false }, { ok: true, value: undefined }],
      ["stale", { readFile: async () => ownerJson(), stat: async () => ({ mtimeMs: NOW - 50_000 }) }, { ok: true, value: undefined }],
      ["unreadable", { readFile: async () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })) }, { ok: true, value: undefined }],
      ["invalid", { readFile: async () => "{not json" }, { ok: true, value: undefined }],
    ];
    for (const [label, script, expected] of cases) assert.deepEqual((await readActive(script)).outcome, expected, label);
    const foreign = await readActive({ readFile: async () => ownerJson({ uid: 9 }) });
    assert.deepEqual(foreign.outcome, { ok: false, error: { name: "StoreLockError", message: "Agent store lock is held by uid 9, expected 501" } });
    let reads = 0;
    const changed = await readActive({ readFile: async () => { reads += 1; return reads === 1 ? ownerJson() : ownerJson({ acquiredAt: NOW - 1 }); }, stat: async () => ({ mtimeMs: NOW - 100 }) });
    assert.deepEqual(changed.outcome, { ok: true, value: undefined }, "a lock that changed between the two reads is not reported as held");
  });
});
