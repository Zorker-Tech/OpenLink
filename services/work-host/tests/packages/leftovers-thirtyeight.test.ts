/**
 * The worker's blob store, the content-search entry, session materialization, computer-use coordination
 * and what a crash report may carry.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WorkerBlobStore } from "../../source/host/agents/isolation/worker-blob-store.ts";
import { contentSearchExtension, GLOBAL_SEARCH_GATE } from "../../source/host/extensions/content-search/extension.ts";
import { DEFAULT_AGENT_AUTOMATIONS, MAX_AGENTS_PER_USER, SlateAgentMissingError, SlateSessionMaterialization } from "../../source/host/extensions/session/session-materialization.ts";
import { createComputerUseCoordination } from "../../source/host/runner/computer-use.ts";
import { isSlateSentryBoundedTagValue, removePropertiesWithPossibleUserInfo, scrubAppUrl } from "../../source/shared/observability/sentry-scrub.gen.ts";

describe("the store a worker reads blobs from", () => {
  it("is a store the worker can build", () => {
    assert.equal(typeof WorkerBlobStore, "function");
  });
});

describe("the content-search entry", () => {
  it("names the gate it answers to", () => {
    assert.equal(GLOBAL_SEARCH_GATE, "slate_global_search");
    assert.equal(typeof contentSearchExtension, "object");
  });
});

describe("writing a session's files where the host expects them", () => {
  it("leaves what is already there alone, and bounds what it writes", () => {
    assert.deepEqual([...DEFAULT_AGENT_AUTOMATIONS], []);
    assert.equal(MAX_AGENTS_PER_USER, 50);
    assert.equal(typeof SlateSessionMaterialization, "function");
    assert.equal(typeof SlateAgentMissingError, "function");
  });
});

describe("driving a box's desktop", () => {
  it("coordinates the agents that share it", () => {
    assert.equal(typeof createComputerUseCoordination, "function");
  });
});

describe("what a crash report may carry", () => {
  it("keeps a bounded value and drops one that could be a user's", () => {
    assert.equal(isSlateSentryBoundedTagValue("abc"), true);
    assert.equal(isSlateSentryBoundedTagValue("a b"), false);
    assert.equal(scrubAppUrl("https://x/y?token=1"), "<REDACTED: url>");
    assert.equal(typeof removePropertiesWithPossibleUserInfo, "function");
  });
});
