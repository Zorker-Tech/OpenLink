import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_STORE_SYNC_DIR_NAME } from "../../source/packages/agent-store-sync/paths.ts";
import { readCurrentAgentStoreMutationOwner, resolveAgentStoreMutationLockPath } from "../../source/packages/agent-store-sync/exclusive-mutation-lock.ts";
import { tryAcquireStoreLock } from "../../source/packages/agent-store-sync/store-lock.ts";

test("the mutation owner is read from the store's sibling synchronization directory", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "agent-store-mutation-lock-"));
  const filesDirectory = join(root, "nested", "..", "files");
  await mkdir(join(root, "files"));
  const lockPath = resolveAgentStoreMutationLockPath(filesDirectory);
  assert.equal(lockPath, join(root, AGENT_STORE_SYNC_DIR_NAME, "exclusive-mutation.lock"));

  try {
    const acquired = await tryAcquireStoreLock({ lockPath, windowId: "window-test", mtimeUpdateMs: 0 });
    assert.equal(acquired.kind, "acquired");
    if (acquired.kind !== "acquired") return;

    try {
      const owner = await readCurrentAgentStoreMutationOwner({ filesDirectory });
      assert.ok(owner);
      assert.equal(owner.windowId, "window-test");
      assert.equal(owner.pid, process.pid);
    } finally {
      await acquired.lock.dispose();
    }
    assert.equal(await readCurrentAgentStoreMutationOwner({ filesDirectory }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
