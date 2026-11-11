/**
 * The coordinator's RPC surface: what a request and a reply may be, which methods exist, and what a malformed reply does.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COORDINATOR_METHOD_TABLE,
  isCoordinatorMethod,
  parseCoordinatorAgentThreadRequest,
  parseCoordinatorAgentThreadResponse,
  parseCoordinatorTranscriptWindowRequest,
  parseCoordinatorTranscriptWindowResponse,
  validateCoordinatorReply,
} from "../../source/shared/rpc/coordinator.ts";

const entry = { id: "e1", kind: "text" };

describe("a paged transcript window", () => {
  it("reads a reply with its thread counts and its cursor, and refuses every other shape", () => {
    assert.deepEqual(parseCoordinatorTranscriptWindowResponse({ entries: [entry], threadCounts: { root: 2 }, nextBeforeSeq: 7 }), {
      entries: [entry],
      nextBeforeSeq: 7,
      threadCounts: { root: 2 },
    });
    // The cursor is optional, and so is the counts object being empty.
    assert.deepEqual(parseCoordinatorTranscriptWindowResponse({ entries: [], threadCounts: {} }), { entries: [], threadCounts: {} });
    for (const bad of [
      null,
      [],
      {},
      { entries: [entry] },
      { entries: [{ id: "", kind: "text" }], threadCounts: {} },
      { entries: [{ id: "e", kind: "" }], threadCounts: {} },
      { entries: [null], threadCounts: {} },
      { entries: [], threadCounts: { "": 1 } },
      { entries: [], threadCounts: { root: "2" } },
      { entries: [], threadCounts: {}, nextBeforeSeq: "7" },
    ]) {
      assert.equal(parseCoordinatorTranscriptWindowResponse(bad), null, JSON.stringify(bad));
    }
  });

  it("reads a request's conversation, cursor and limit, and refuses a cursor that is not a whole number", () => {
    assert.deepEqual(parseCoordinatorTranscriptWindowRequest({ id: "conv-1" }), { id: "conv-1" });
    assert.deepEqual(parseCoordinatorTranscriptWindowRequest({ id: "conv-1", beforeSeq: 4, limit: 20 }), { id: "conv-1", beforeSeq: 4, limit: 20 });
    for (const bad of [null, [], {}, { id: "" }, { id: 1 }, { id: "c", beforeSeq: 1.5 }, { id: "c", beforeSeq: "4" }, { id: "c", limit: "20" }]) {
      assert.equal(parseCoordinatorTranscriptWindowRequest(bad), null, JSON.stringify(bad));
    }
  });
});

describe("an agent thread", () => {
  it("reads a thread's request and reply", () => {
    assert.deepEqual(parseCoordinatorAgentThreadRequest({ id: "conv-1", rootId: "root-1" }), { id: "conv-1", rootId: "root-1" });
    for (const bad of [null, {}, { id: "c" }, { id: "", rootId: "r" }, { id: "c", rootId: "" }, { id: 1, rootId: "r" }]) {
      assert.equal(parseCoordinatorAgentThreadRequest(bad), null, JSON.stringify(bad));
    }
    assert.deepEqual(parseCoordinatorAgentThreadResponse({ entries: [entry, entry] }), { entries: [entry, entry] });
    for (const bad of [null, {}, { entries: [{}] }, { entries: "no" }]) {
      assert.equal(parseCoordinatorAgentThreadResponse(bad), null, JSON.stringify(bad));
    }
  });
});

describe("what the coordinator serves", () => {
  it("validates the two replies it validates, and passes everything else through untouched", () => {
    assert.deepEqual(validateCoordinatorReply("getAgentTranscriptWindow", { entries: [], threadCounts: {} }), { entries: [], threadCounts: {} });
    assert.throws(() => validateCoordinatorReply("getAgentTranscriptWindow", { entries: [] }), /malformed transcript window/);
    assert.deepEqual(validateCoordinatorReply("getAgentThread", { entries: [] }), { entries: [] });
    assert.throws(() => validateCoordinatorReply("getAgentThread", {}), /malformed agent thread/);
    // A method with no validation is not inspected at all.
    const anything = { whatever: true };
    assert.equal(validateCoordinatorReply("listAgents", anything), anything);
  });

  it("knows every method it serves, and answers unknown for anything else", () => {
    const methods = Object.keys(COORDINATOR_METHOD_TABLE);
    assert.equal(new Set(methods).size, methods.length);
    assert.equal(isCoordinatorMethod("getAgentTranscriptWindow"), true);
    assert.equal(isCoordinatorMethod("sendPrompt"), true);
    assert.equal(isCoordinatorMethod("createBackgroundAgent"), true);
    assert.equal(isCoordinatorMethod("appendAgentTranscriptEntries"), true);
    assert.equal(isCoordinatorMethod("replaceAgentTranscriptEntries"), true);
    assert.equal(isCoordinatorMethod("notAMethod"), false);
    // `hasOwn` semantics: a name from the prototype chain is not a method.
    assert.equal(isCoordinatorMethod("toString"), false);
    assert.equal(isCoordinatorMethod("constructor"), false);
    // Every entry says what it takes and what it answers with.
    for (const [method, shape] of Object.entries(COORDINATOR_METHOD_TABLE)) {
      assert.match(shape, /^(object|none)\/[a-z-]+$/, method);
    }
  });
});
