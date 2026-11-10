import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";

import { resolveConversationBlobStorePath } from "../../source/host/extensions/session/conversation-blobs-path.ts";
import { CONVERSATION_BLOBS_FILENAME } from "../../source/host/extensions/session/session-paths.ts";

test("the conversation blob store sits beside the primary store file", () => {
  assert.equal(
    resolveConversationBlobStorePath("/profile/.slate/projects/p1/agent.db"),
    join("/profile/.slate/projects/p1", CONVERSATION_BLOBS_FILENAME),
  );
  assert.equal(resolveConversationBlobStorePath("agent.db"), CONVERSATION_BLOBS_FILENAME);
});
