import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SlateConnectorSecretStore } from "../../source/host/extensions/session/connector-secret-store.ts";

test("connector secret storage merges atomically, reads only non-empty strings, and bounds coordinates", () => {
  const root = mkdtempSync(join(tmpdir(), "slate-connector-secrets-"));
  try {
    const store = new SlateConnectorSecretStore(root);
    assert.equal(store.setSecret("agent-a", "gitlab", "access", "token-a"), true);
    assert.equal(store.setSecret("agent-a", "gitlab", "refresh", "token-b"), true);
    assert.deepEqual(store.read("agent-a", "gitlab"), {
      access: "token-a",
      refresh: "token-b",
    });
    assert.equal(store.getSecret("agent-a", "gitlab", "access"), "token-a");
    assert.equal(store.getSecret("agent-a", "gitlab", "missing"), null);
    assert.deepEqual(readFileSync(store.filePath("agent-a", "gitlab"), "utf8"),
      '{\n  "access": "token-a",\n  "refresh": "token-b"\n}\n');

    assert.equal(store.setSecret("../outside", "gitlab", "access", "blocked"), false);
    assert.equal(store.setSecret("agent-a", "../gitlab", "access", "blocked"), false);
    assert.equal(store.setSecret("agent-a", "gitlab", "", "blocked"), false);
    assert.equal(store.getSecret("../outside", "gitlab", "access"), null);
    store.removeAgentPlatform("../outside", "gitlab");
    assert.equal(store.getSecret("agent-a", "gitlab", "access"), "token-a");

    mkdirSync(join(root, "agent-b"), { recursive: true });
    writeFileSync(store.filePath("agent-b", "gitlab"), "[not an object]", "utf8");
    assert.deepEqual(store.read("agent-b", "gitlab"), {});
    store.removeAgentPlatform("agent-a", "gitlab");
    store.removeAgentPlatform("agent-a", "gitlab");
    assert.equal(store.getSecret("agent-a", "gitlab", "access"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
