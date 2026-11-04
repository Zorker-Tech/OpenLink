/**
 * The inference-protocol package's door, the blob reference table and the conversation blob collector.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collectReachableBlobHexIds, EDGES_NOT_WALKED_SO_REFERENTS_COLLECT, toHexId } from "../../source/adapters/interop/agent/conversation-blob-reachability-adapter.ts";
import { BLOB_REFERENCE_MESSAGE_TYPE_BY_NAME, BLOB_REFERENCE_METADATA_BY_MESSAGE_ID, isProtoBlobReferenceTypeName } from "../../source/adapters/interop/agent/blob-reference-metadata.ts";
import * as inferenceProto from "../../source/adapters/interop/chat-inference-proto/index.ts";

describe("the inference-protocol package's door", () => {
  it("is what the client, the converters and the provider options offer", () => {
    assert.equal(Object.keys(inferenceProto).length > 50, true);
  });
});

describe("which fields can carry a blob reference", () => {
  it("is a table over the conversation messages, with the kind each reference is", () => {
    assert.equal(Object.keys(BLOB_REFERENCE_MESSAGE_TYPE_BY_NAME).length, 19);
    assert.equal(Object.keys(BLOB_REFERENCE_METADATA_BY_MESSAGE_ID).length, 24);
    assert.equal(typeof isProtoBlobReferenceTypeName, "function");
  });
});

describe("collecting the blobs a conversation no longer refers to", () => {
  it("walks what it can and names the edges it does not walk", () => {
    assert.equal(EDGES_NOT_WALKED_SO_REFERENTS_COLLECT.size, 3);
    assert.equal(EDGES_NOT_WALKED_SO_REFERENTS_COLLECT.has("agent.v1.ConversationStateStructure.summary_archive"), true);
    assert.equal(typeof collectReachableBlobHexIds, "function");
    assert.equal(toHexId(new Uint8Array([1, 2])), "0102");
  });
});
