import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ACTIVE_AGENT_FILENAME,
  CONNECTOR_SECRETS_DIRNAME,
  CONVERSATION_BLOBS_FILENAME,
  getAgentDbPath,
  getConnectorSecretsRoot,
  getSlateTranscriptsDir,
  HIDDEN_ENTRY_REPAIR_VERSION,
  isStaleRootGcEnabled,
  LEGACY_GROUP_MEMBERS_DIRNAME,
  pinStaleRootGc,
  SLATE_CONVERSATION_ROOT_SLOT_ID,
  STALE_ROOT_CLEANUP_VERSION,
  statIfExists,
  STORE_FILENAME,
} from "../../source/host/extensions/session/session-paths.ts";

test("session paths share the root layout and validate agent ids before joining", () => {
  assert.equal(STORE_FILENAME, "store.db");
  assert.equal(CONVERSATION_BLOBS_FILENAME, "conversation-blobs.db");
  assert.equal(ACTIVE_AGENT_FILENAME, "active-agent.json");
  assert.equal(CONNECTOR_SECRETS_DIRNAME, "connector-secrets");
  assert.equal(LEGACY_GROUP_MEMBERS_DIRNAME, "members");
  assert.equal(STALE_ROOT_CLEANUP_VERSION, 1);
  assert.equal(HIDDEN_ENTRY_REPAIR_VERSION, 1);
  assert.equal(new TextDecoder().decode(SLATE_CONVERSATION_ROOT_SLOT_ID), "slate-live-conversation-root-v1__");
  assert.ok(getSlateTranscriptsDir("/home/example").startsWith("/home/example"));
  assert.equal(getAgentDbPath("/agents", "agent-a"), join("/agents", "agent-a", "store.db"));
  assert.throws(() => getAgentDbPath("/agents", "../outside"));
  assert.equal(getConnectorSecretsRoot("/root/.slate/agents"), "/root/.slate/connector-secrets");
});

test("stale-root cleanup environment switches override the host default", () => {
  pinStaleRootGc(false);
  try {
    assert.equal(isStaleRootGcEnabled({ SLATE_STALE_ROOT_GC: "true" } as NodeJS.ProcessEnv), true);
    assert.equal(isStaleRootGcEnabled({ SLATE_STALE_ROOT_GC: "OFF" } as NodeJS.ProcessEnv), false);
    assert.equal(isStaleRootGcEnabled({} as NodeJS.ProcessEnv), false);
    pinStaleRootGc(true);
    assert.equal(isStaleRootGcEnabled({} as NodeJS.ProcessEnv), true);
  } finally {
    pinStaleRootGc(false);
  }
});

test("path stat distinguishes absence from an existing file", async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-session-paths-"));
  try {
    const file = join(root, "store.db");
    writeFileSync(file, "db", "utf8");
    assert.equal((await statIfExists(file))?.isFile(), true);
    assert.equal(await statIfExists(join(root, "missing.db")), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
