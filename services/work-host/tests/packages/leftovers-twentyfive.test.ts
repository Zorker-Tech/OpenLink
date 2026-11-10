/**
 * The browser-session watcher and staging, the host-upgrade entry, the channel store, the forever box's
 * service, the production bindings, the telemetry helper process and the teach-recording entry.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ChromeSessionWatcher } from "../../source/host/boxes/box-store-sync/chrome-session-watcher.ts";
import { CHROME_SESSION_CATEGORY_NAME, CHROME_SESSION_DB_DIR } from "../../source/host/boxes/box-store-sync/chrome-session-stage.ts";
import { createHostUpgradeExtension, HOST_UPGRADE_MARKER_FORWARD_INTERVAL_MS } from "../../source/host/extensions/host-upgrade/extension.ts";
import { CHANNELS_DIRNAME, CHANNEL_CHANGE_DEBOUNCE_MS, CHANNEL_CONFIG_FILENAME, FileChannelStore } from "../../source/host/extensions/session/channel-store.ts";
import { FOREVER_BOX_IMAGE_WATCH_INTERVAL_MS } from "../../source/host/boxes/forever-box/forever-box-service.ts";
import { createProductionStateBackstop, productionSecretsContext } from "../../source/host/production-binding-providers.ts";
import { CsnapsProcess, CsnapsProcessError, describeCsnapsExit } from "../../source/host/extensions/codebase-telemetry/csnaps-process.ts";
import { CAP_SLACK_MS, parseTeachQueueKey, TEACH_QUEUE_KEY_FILENAME, teachRecordingExtension } from "../../source/host/extensions/teach-recording/extension.ts";

describe("the browser's session files", () => {
  it("are watched as their own category, and staged from the profile they live in", () => {
    assert.equal(typeof ChromeSessionWatcher, "function");
    assert.equal(CHROME_SESSION_CATEGORY_NAME, "chrome-session");
    assert.equal(CHROME_SESSION_DB_DIR, "/home/box/chrome-profile/Default");
  });
});

describe("the host upgrade entry", () => {
  it("forwards what an upgrade left behind on its own interval", () => {
    assert.equal(HOST_UPGRADE_MARKER_FORWARD_INTERVAL_MS, 300_000);
    assert.equal(typeof createHostUpgradeExtension, "function");
  });
});

describe("what a session learned from its channels", () => {
  it("is kept beside the agent, in its own directory with its own file", () => {
    assert.equal(CHANNELS_DIRNAME, "channels");
    assert.equal(CHANNEL_CONFIG_FILENAME, "connection.json");
    assert.equal(CHANNEL_CHANGE_DEBOUNCE_MS, 50);
    assert.equal(typeof FileChannelStore, "function");
  });
});

describe("the box the host keeps for itself", () => {
  it("watches its image on an interval", () => {
    assert.equal(FOREVER_BOX_IMAGE_WATCH_INTERVAL_MS, 24 * 60 * 60 * 1_000);
  });
});

describe("the providers a production host binds", () => {
  it("are wired once, so the rest of the host asks a typed port", () => {
    assert.equal(typeof createProductionStateBackstop, "function");
    assert.equal(typeof productionSecretsContext, "function");
  });
});

describe("the telemetry helper as a process", () => {
  it("names the errors it raises and what an exit means", () => {
    assert.equal(typeof CsnapsProcess, "function");
    assert.equal(new CsnapsProcessError("failed").message, "failed");
    assert.equal(typeof describeCsnapsExit, "function");
  });
});

describe("the teach-recording entry", () => {
  it("bounds how much it keeps and names the key it queues under", () => {
    assert.equal(CAP_SLACK_MS, 2_000);
    assert.equal(TEACH_QUEUE_KEY_FILENAME, "teach-queue-key.json");
    assert.equal(typeof parseTeachQueueKey, "function");
    assert.equal(typeof teachRecordingExtension, "object");
  });
});
