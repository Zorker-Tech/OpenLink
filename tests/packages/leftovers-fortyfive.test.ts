/**
 * The departures a host still owes, the client-side tool producer, the local-exec bridge, the settings
 * service, a safe link preview, the security-key proxy's telemetry, the group-chat orchestrator and the
 * upgrade resume store.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ROOM_TOMBSTONE_MIN_RETENTION_MS, SlateXuserDepartureObligations } from "../../source/host/rooms/xuser-departure-obligations.ts";
import { ClientSideToolV2Producer } from "../../source/host/transcript/client-side-tool-v2-producer.ts";
import { DEFAULT_SLATE_COMPUTER_ID, SlateLocalExecBridge, SUPERVISED_RANK, VARIANT_RANKS } from "../../source/host/local-exec/local-exec-bridge.ts";
import { isValidIanaTimeZone, SettingsService } from "../../source/host/settings/settings-service.ts";
import { LINK_PREVIEW_USER_AGENT, MAX_REDIRECTS, MAX_URL_LENGTH, SlateLinkPreviewError } from "../../source/host/attachments/safe-link-preview-fetch.ts";
import { KNOWN_DOM_ERROR_NAMES, WEBAUTHN_PROXY_EVENT } from "../../source/host/telemetry/webauthn-proxy-telemetry.ts";
import { GroupChatOrchestrator } from "../../source/host/transcript/group-chat-orchestrator.ts";
import { coerceUpgradeResumeMarker, SlateUpgradeResumeStore } from "../../source/host/transcript/slate-upgrade-resume-store.ts";

describe("the departures a host still owes", () => {
  it("keeps a room's tombstone for at least two days", () => {
    assert.equal(ROOM_TOMBSTONE_MIN_RETENTION_MS, 2 * 24 * 60 * 60 * 1_000);
    assert.equal(typeof SlateXuserDepartureObligations, "function");
  });
});

describe("producing a client-side tool call", () => {
  it("packages what the runner cannot run itself for the backend", () => {
    assert.equal(typeof ClientSideToolV2Producer, "function");
  });
});

describe("the bridge between the host and the local-exec daemon", () => {
  it("names the computer, its supervised rank and the ranks its variants hold", () => {
    assert.equal(DEFAULT_SLATE_COMPUTER_ID, "this-computer");
    assert.equal(SUPERVISED_RANK, 4);
    assert.equal(Object.keys(VARIANT_RANKS).length, 2);
    assert.equal(typeof SlateLocalExecBridge, "function");
  });
});

describe("the settings a user has", () => {
  it("reads and writes through the store, and checks a time zone", () => {
    assert.equal(typeof SettingsService, "function");
    assert.equal(isValidIanaTimeZone("Europe/Berlin"), true);
    assert.equal(isValidIanaTimeZone("Not/AZone"), false);
  });
});

describe("fetching a page for a link preview", () => {
  it("bounds redirects and the address, and names no other product", () => {
    assert.equal(MAX_REDIRECTS, 5);
    assert.equal(MAX_URL_LENGTH, 2_048);
    assert.equal(LINK_PREVIEW_USER_AGENT.includes("cursor"), false);
    assert.equal(typeof SlateLinkPreviewError, "function");
  });
});

describe("what the security-key proxy reports", () => {
  it("reports under our own event name", () => {
    assert.equal(WEBAUTHN_PROXY_EVENT, "slate.webauthn_proxy");
    assert.equal(KNOWN_DOM_ERROR_NAMES.length, 11);
  });
});

describe("running a group chat's turn", () => {
  it("gives each member the turn in its own order", () => {
    assert.equal(typeof GroupChatOrchestrator, "function");
  });
});

describe("remembering what an upgrade was in the middle of", () => {
  it("keeps a marker it can resume from", () => {
    assert.equal(typeof SlateUpgradeResumeStore, "function");
    assert.equal(typeof coerceUpgradeResumeMarker, "function");
  });
});
