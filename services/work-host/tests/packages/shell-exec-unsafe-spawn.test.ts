import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";

import { spawnUnsafe } from "../../source/packages/shell-exec/sandbox/unsafe-spawn.ts";

const execPath = process.execPath;

describe("the unsandboxed spawn branch", () => {
  it("forwards the command, its arguments and its options", async () => {
    const child = spawnUnsafe(execPath, ["-e", "process.exit(7)"], { stdio: "ignore" });
    assert.equal(child.spawnfile, execPath);
    assert.deepEqual(child.spawnargs, [execPath, "-e", "process.exit(7)"]);
    assert.equal(child.stdout, null, "the options reached the child, not just the arguments");
    const [code] = await once(child, "close") as [number | null];
    assert.equal(code, 7);
  });

  it("gives every call its own default arguments", async () => {
    const first = spawnUnsafe(execPath, undefined, { stdio: "ignore" });
    const second = spawnUnsafe(execPath, undefined, { stdio: "ignore" });
    try {
      assert.deepEqual(first.spawnargs, [execPath]);
      assert.notEqual(first.spawnargs, second.spawnargs, "the default argument list is not shared between calls");
    } finally {
      first.kill();
      second.kill();
      await Promise.all([once(first, "close").catch(() => undefined), once(second, "close").catch(() => undefined)]);
    }
  });

  it("uses the platform's own spawn defaults when given no options", async () => {
    const child = spawnUnsafe(execPath, ["-e", "process.exit(0)"]);
    assert.notEqual(child.stdout, null, "no stdio option means the child's streams are pipes");
    await once(child, "close");
  });

  it("lets a spawn failure reach the caller as the child's error", async () => {
    const child = spawnUnsafe("slate-definitely-not-a-command-xyz", [], { stdio: "ignore" });
    const [error] = await once(child, "error") as [Error & { code?: string }];
    assert.equal(error.code, "ENOENT");
  });
});