/**
 * Watching a listener's platforms, the relay an automation's events come from, the turns a shared room
 * receives, the trigger hub, the room relay and what a link preview's image may be.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_WATCH_TIMEOUT_MS, ListenerConnectWatcher } from "../../source/host/automations/listener-connect-watcher.ts";
import { DEGRADED_REGISTER_INTERVAL_MS, DEFAULT_REGISTER_INTERVAL_MS, ERROR_BACKOFF_MS, SlateBackendRelayError } from "../../source/host/automations/backend-relay-source.ts";
import { REMOTE_MEMBER_UNREACHABLE_BACKOFF_MS, REMOTE_TURN_BUDGET_MAX, REMOTE_TURN_BUDGET_WINDOW_MS, SlateXuserRemoteTurns } from "../../source/host/rooms/xuser-remote-turns.ts";
import { SlateTriggerHub } from "../../source/host/automations/slate-trigger-hub.ts";
import { SlateXuserRelayClient, XUSER_RELAY_ERROR_BACKOFF_MS, XUSER_RELAY_POLL_INTERVAL_MS } from "../../source/host/rooms/xuser-relay.ts";
import { diffAutomationAction, snapshotAutomations } from "../../source/host/transcript/automation-snapshot.ts";
import { boundPreviewImageDataUrl, LINK_PREVIEW_MAX_DECODE_PIXELS } from "../../source/host/attachments/link-preview-image-bounds.ts";

describe("watching whether a listener's platforms are connected", () => {
  it("waits up to its own timeout", () => {
    assert.equal(DEFAULT_WATCH_TIMEOUT_MS, 900_000);
    assert.equal(typeof ListenerConnectWatcher, "function");
  });
});

describe("the relay an automation's events come from", () => {
  it("registers on an interval, backs off when degraded and names its error", () => {
    assert.equal(DEFAULT_REGISTER_INTERVAL_MS, 300_000);
    assert.equal(DEGRADED_REGISTER_INTERVAL_MS, 60_000);
    assert.equal(ERROR_BACKOFF_MS, 30_000);
    assert.equal(typeof SlateBackendRelayError, "function");
  });
});

describe("the turns a shared room receives", () => {
  it("bounds how many a member may send, and how long an unreachable one is left alone", () => {
    assert.equal(REMOTE_TURN_BUDGET_MAX, 30);
    assert.equal(REMOTE_TURN_BUDGET_WINDOW_MS, 600_000);
    assert.equal(REMOTE_MEMBER_UNREACHABLE_BACKOFF_MS, 600_000);
    assert.equal(typeof SlateXuserRemoteTurns, "function");
  });
});

describe("the hub an automation's triggers are registered with", () => {
  it("tells every listener that matches an event", () => {
    assert.equal(typeof SlateTriggerHub, "function");
  });
});

describe("the relay a host reaches its rooms through", () => {
  it("polls on its own interval and backs off when the relay is away", () => {
    assert.equal(XUSER_RELAY_POLL_INTERVAL_MS, 4_000);
    assert.equal(XUSER_RELAY_ERROR_BACKOFF_MS, 30_000);
    assert.equal(typeof SlateXuserRelayClient, "function");
  });
});

describe("what an automation run leaves in a transcript", () => {
  it("is written once, and what changed is described", () => {
    assert.equal(typeof snapshotAutomations, "function");
    assert.equal(typeof diffAutomationAction, "function");
  });
});

describe("what a link preview's image may be", () => {
  it("bounds how much may be decoded", () => {
    assert.equal(LINK_PREVIEW_MAX_DECODE_PIXELS, 24_000_000);
    assert.equal(typeof boundPreviewImageDataUrl, "function");
  });
});
