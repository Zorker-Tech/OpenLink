import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createContext } from "../../source/packages/context/context.ts";
import { SlateSessionConversationState } from "../../source/host/extensions/session/session-conversation-state.ts";
import { SlateSessionMaterialization } from "../../source/host/extensions/session/session-materialization.ts";
import { createSessionStoreFactory } from "../../source/host/extensions/session/session-production-store.ts";

test("the production store wires Slate conversation state and lazy materialization", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "slate-production-session-"));
  try {
    const store = createSessionStoreFactory({
      rootDir,
      context: createContext(),
    })(() => "UTC");

    assert.equal(store.getRootDir(), rootDir);
    assert.equal(store.conversationState instanceof SlateSessionConversationState, true);
    assert.equal(store.materialization instanceof SlateSessionMaterialization, true);
    assert.equal(
      (store.materialization as SlateSessionMaterialization | undefined)?.host.rootDir,
      rootDir,
    );

    await store.closeWorkerPool();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
