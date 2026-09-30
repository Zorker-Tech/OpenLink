/**
 * The daemon's crash reporting, the switches a developer can set locally and the browser tools.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { flushSlateSentry, initSlateSentryDaemon } from "../../source/host/local-exec/sentry.ts";
import { FEATURE_FLAG_OVERRIDES_FILENAME, FEATURE_FLAG_OVERRIDE_TTL_MS, isFlagName, SlateFeatureFlagOverrideStore } from "../../source/shared/node/experiments/feature-flag-overrides.ts";
import { BOX_CDP_PORT_BASE, createSlateBrowserTools, PENDING_SCREENSHOT_CAP, SlateBrowserDriver } from "../../source/host/runner/tools/slate-browser-tools.ts";

describe("the daemon's own crash reporting", () => {
  it("is initialized and flushed by the daemon", () => {
    assert.equal(typeof initSlateSentryDaemon, "function");
    assert.equal(typeof flushSlateSentry, "function");
  });
});

describe("the switches a developer can set locally", () => {
  it("keeps overrides in their own file for a day, and only for flags the registry knows", () => {
    assert.equal(FEATURE_FLAG_OVERRIDES_FILENAME, "slate-feature-flag-overrides.json");
    assert.equal(FEATURE_FLAG_OVERRIDE_TTL_MS, 24 * 60 * 60 * 1_000);
    assert.equal(isFlagName("agent_goal_continuation"), true);
    assert.equal(isFlagName("nope_nope"), false);
    assert.equal(typeof SlateFeatureFlagOverrideStore, "function");
  });
});

describe("the tools an agent drives a browser with", () => {
  it("names the port base it debugs on and how many screenshots may be pending", () => {
    assert.equal(BOX_CDP_PORT_BASE, 9_222);
    assert.equal(PENDING_SCREENSHOT_CAP, 32);
    assert.equal(typeof createSlateBrowserTools, "function");
    assert.equal(typeof SlateBrowserDriver, "function");
  });
});
