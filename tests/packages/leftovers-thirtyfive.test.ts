/**
 * The resources a box offers the runner, the action audit and the content search service.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BoxNotReadyError, createRemoteBoxResourceAccessor } from "../../source/host/runner/remote-box-resources.ts";
import { computerUseAuditKind, IGNORED_URL_PREFIXES, NAVIGATION_PROBE_CDP_BASE_PORT, NAVIGATION_PROBE_MIN_INTERVAL_MS } from "../../source/host/runner/slate-action-audit.ts";
import { MAX_FAILED_JOB_RECONCILES, MAX_INDEX_REBUILDS, MAX_WORKER_RESPAWNS, SEARCH_INDEX_DISPOSE_TIMEOUT_MS, SlateSearchIndexService } from "../../source/host/extensions/content-search/search-index-service.ts";

describe("the resources a box offers the runner", () => {
  it("names the error a box that is not up yet raises, and builds the accessor", () => {
    assert.equal(new BoxNotReadyError().name, "BoxNotReadyError");
    assert.equal(typeof createRemoteBoxResourceAccessor, "function");
  });
});

describe("auditing what an agent did", () => {
  it("knows which page visits are not probed, and how often a probe may run", () => {
    assert.equal(NAVIGATION_PROBE_CDP_BASE_PORT > 0, true);
    assert.equal(NAVIGATION_PROBE_MIN_INTERVAL_MS > 0, true);
    assert.equal(Array.isArray(IGNORED_URL_PREFIXES), true);
    assert.equal(typeof computerUseAuditKind, "function");
  });
});

describe("the content search, as a service", () => {
  it("bounds its rebuilds, respawns and reconciles, and gives disposal a deadline", () => {
    assert.equal(MAX_INDEX_REBUILDS > 0, true);
    assert.equal(MAX_WORKER_RESPAWNS > 0, true);
    assert.equal(MAX_FAILED_JOB_RECONCILES > 0, true);
    assert.equal(SEARCH_INDEX_DISPOSE_TIMEOUT_MS > 0, true);
    assert.equal(typeof SlateSearchIndexService, "function");
  });
});
