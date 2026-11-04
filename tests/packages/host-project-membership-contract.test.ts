import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AgentProjectMembershipStore } from "../../source/host/memory/project-membership.ts";

test("project membership persists safe slugs in a stable atomic document", () => {
  const root = mkdtempSync(join(tmpdir(), "slate-project-membership-"));
  try {
    const store = new AgentProjectMembershipStore(join(root, "agent-a"));
    assert.equal(store.join("zeta"), true);
    assert.equal(store.join("alpha"), true);
    assert.equal(store.join("alpha"), true);
    assert.deepEqual([...store.read()], ["alpha", "zeta"]);
    assert.equal(readFileSync(store.path, "utf8"), '{\n  "projects": [\n    "alpha",\n    "zeta"\n  ]\n}\n');

    assert.equal(store.join("../escape"), false);
    assert.equal(store.leave("../escape"), false);
    assert.equal(store.leave("missing"), true);
    store.pruneMissing((slug) => slug === "alpha");
    assert.deepEqual([...store.read()], ["alpha"]);
    assert.equal(store.leave("alpha"), true);
    assert.deepEqual([...store.read()], []);

    writeFileSync(store.path, "{ not json", "utf8");
    assert.deepEqual([...store.read()], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
