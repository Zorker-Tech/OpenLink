/**
 * Repository names out of git remotes, the egress tunnel's state, one sync round at a time, and the two
 * pieces around a turn: its memory and the content index.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractRepoNameFromGitUrl } from "../../source/packages/agent-analytics/commit-scoring/git-repo-utils.ts";
import { ANYRUN_NETWORK_TOKEN_HEADER, configsEqual, OFF_STATUS } from "../../source/shared/node/egress-tunnel/egress-tunnel-controller.ts";
import { isSyncRoundStoodAsideError, SyncRoundScheduler, SyncRoundStoodAsideError } from "../../source/packages/agent-store-sync/sync-round-scheduler.ts";
import { extractCompletedTurnMemories, settleCompletedTurnMemory } from "../../source/host/runner/turn-memory.ts";
import { INCREMENTAL_VACUUM_PAGES, SlateSearchIndexWriter, STORE_FILENAME } from "../../source/host/extensions/content-search/search-index-writer.ts";

describe("reading a repository out of a git remote", () => {
  it("takes the name from the forms git accepts, and nothing from one it does not", () => {
    assert.equal(extractRepoNameFromGitUrl("https://github.com/org/repo.git"), "org/repo");
    assert.equal(extractRepoNameFromGitUrl("git@github.com:org/repo.git"), "org/repo");
    assert.equal(extractRepoNameFromGitUrl("ssh://git@host:2222/o/r.git"), "o/r");
    assert.equal(extractRepoNameFromGitUrl("not a url"), undefined);
  });
});

describe("the tunnel that carries a box's egress", () => {
  it("has a state for being off, and names the header the network token travels in", () => {
    assert.deepEqual(OFF_STATUS, { state: "off", relayedStreams: 0, activeStreams: 0 });
    assert.equal(ANYRUN_NETWORK_TOKEN_HEADER, "x-slate-network-token");
    assert.equal(typeof configsEqual, "function");
  });
});

describe("one sync round at a time", () => {
  it("knows the error it raises when a round stood aside", () => {
    const error = new SyncRoundStoodAsideError();
    assert.equal(isSyncRoundStoodAsideError(error), true);
    assert.equal(isSyncRoundStoodAsideError(new Error("other")), false);
    assert.equal(typeof SyncRoundScheduler, "function");
  });
});

describe("what a turn leaves behind", () => {
  it("offers the memory it extracted and the turn it belongs to", () => {
    assert.equal(typeof extractCompletedTurnMemories, "function");
    assert.equal(typeof settleCompletedTurnMemory, "function");
  });
});

describe("the content index", () => {
  it("is its own store, with a page size for the vacuum it runs", () => {
    assert.equal(STORE_FILENAME, "store.db");
    assert.equal(INCREMENTAL_VACUUM_PAGES, 512);
    assert.equal(typeof SlateSearchIndexWriter, "function");
  });
});
