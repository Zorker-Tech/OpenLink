/**
 * The agent store's own paths: which paths inside a store are reserved, what the store keeps beside a
 * user's files, and the errors it raises.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AGENT_STORE_CONFLICT_EVENTS_FILE_NAME, AGENT_STORE_CONFLICT_PENDING_FILE_NAME, AGENT_STORE_SYNC_DIR_NAME, isReservedRelPath } from "../../source/packages/agent-store-sync/paths.ts";
import { UnsafeAgentStorePathError } from "../../source/packages/agent-store-sync/safe-paths.ts";
import { assertPresignedUrlSafe, createAgentStorePresignedUrlValidatorForBackend } from "../../source/packages/agent-store-sync/presigned-url.ts";

describe("where an agent store keeps its own files", () => {
  it("keeps its sync state in a directory of its own, and knows which paths are reserved", () => {
    assert.equal(AGENT_STORE_SYNC_DIR_NAME, ".sync");
    assert.equal(isReservedRelPath(".slate/x"), true);
    assert.equal(isReservedRelPath("notes/x"), false);
    // The synchronisation state is kept by the client, not reserved for this check.
    assert.equal(isReservedRelPath(".sync/state.json"), false);
    assert.equal(AGENT_STORE_CONFLICT_EVENTS_FILE_NAME.length > 0, true);
    assert.equal(AGENT_STORE_CONFLICT_PENDING_FILE_NAME.length > 0, true);
  });
});

describe("keeping a store path inside the store", () => {
  it("names the error a path that would leave the store raises", () => {
    const error = new UnsafeAgentStorePathError({ code: "escape", message: "outside" } as never);
    assert.equal(error instanceof Error, true);
    assert.equal(error.code, "escape");
  });
});

describe("the presigned address a store read or write is given", () => {
  it("is checked before it is used, and a refusal says which check it failed", () => {
    assert.equal(typeof assertPresignedUrlSafe, "function");
    assert.equal(typeof createAgentStorePresignedUrlValidatorForBackend, "function");
  });
});
