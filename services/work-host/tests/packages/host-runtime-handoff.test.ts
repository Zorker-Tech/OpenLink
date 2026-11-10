/**
 * The host's runtime pieces, fifth group: an agent's settings and profile, the managed-setup ports, the
 * upgrade hand-off, connector secrets, the store's packs, room tombstones and the telemetry around them.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { bestEffortAccessToken, type ManagedAuthPort } from "../../source/host/extensions/managed-setup/extension.ts";
import { AUTOMATION_SHADOW_PRUNE_EVENT, automationShadowPruneTelemetry } from "../../source/host/telemetry/automation-shadow-prune-telemetry.ts";
import { SLATE_SUPERVISOR_COMMAND_PATH, SLATE_SUPERVISOR_DIR } from "../../source/host/extensions/host-upgrade/host-bundle-upgrade.ts";
import { SlateConnectorSecretStore } from "../../source/host/extensions/session/connector-secret-store.ts";
import { DEFAULT_HIDDEN_FROM_SIDEBAR, DEFAULT_NOTIFY_ON_AGENT_UPDATES, getSlateSettingsPath, agentSettingsAt, SLATE_SETTINGS_FILENAME, writeAgentSettings } from "../../source/host/agents/settings-file.ts";
import { BOX_STORE_PACK_INDEX_KEY, PACK_MEMBER_MAX_BYTES, PACK_INDEX_VERSION } from "../../source/host/boxes/box-store-sync/box-store-pack.ts";
import { csnapsPath } from "../../source/host/extensions/codebase-telemetry/csnaps-capability.ts";
import { tombstoneKey } from "../../source/host/rooms/xuser-room-tombstone-store.ts";
import { FAILED_RESOLUTION_RETRY_MS, MAX_CACHED_RENDITIONS, VIDEO_TOOL_TIMEOUT_MS } from "../../source/host/attachments/video-playback-rendition.ts";
import { TURN_EMPTY_DELIVERY_EVENT } from "../../source/host/telemetry/turn-empty-delivery-telemetry.ts";
import { isProductionBackendUrl, resolveXuserSharingEnvironment, SLATE_DEV_XUSER_SHARING_ENV, SLATE_XUSER_SHARING_ALLOW_PROD_ENV } from "../../source/host/rooms/xuser-sharing-environment.ts";
import { GITHUB_LISTENER_SCOPE, GITHUB_LISTENER_SCOPE_CREATED_BEFORE_MS, isRoutineNoticeId } from "../../source/host/automations/routine-notices.ts";
import { DEFAULT_EARLY_RESULT_REMINDER_THRESHOLD, DEFAULT_SEND_MESSAGE_REMINDER_THRESHOLD, SEND_MESSAGE_REMINDER_MESSAGE, SLATE_SEND_MESSAGE_TOOL_NAME } from "../../source/host/runner/send-message-reminder-middleware.ts";
import { JOURNAL_OUTCOME_EVENT } from "../../source/host/telemetry/journal-outcome-telemetry.ts";
import { SHELL_REVIVAL_EVENT, subagentRevivalTelemetry, SUBAGENT_REVIVAL_EVENT } from "../../source/host/telemetry/revival-telemetry-mappers.ts";
import { RUNNER_UNATTACHED_MESSAGE } from "../../source/host/transcript/transcript-hub.ts";
import { SLATE_PROFILE_FILENAME, getSlateProfilePath, readSlateProfileFile } from "../../source/host/agents/agent-profile.ts";
import { BOX_LOG_SHIP_EVENT } from "../../source/host/telemetry/box-log-ship-telemetry.ts";
import { HYDRATION_WAIT_MS } from "../../source/host/telemetry/model-experiment-exposure.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-host-runtime-5-"));
after(() => { rmSync(scratch, { recursive: true, force: true }); });

describe("an agent's own settings", () => {
  it("defaults to being told about updates and being visible, and round-trips what was written", () => {
    assert.equal(SLATE_SETTINGS_FILENAME, "settings.json");
    assert.equal(DEFAULT_NOTIFY_ON_AGENT_UPDATES, true);
    assert.equal(DEFAULT_HIDDEN_FROM_SIDEBAR, false);
    const dir = join(scratch, "agent-settings");
    const path = getSlateSettingsPath(dir);
    assert.equal(path, join(dir, "settings.json"));
    mkdirSync(dir, { recursive: true });
    assert.deepEqual(agentSettingsAt(path), { notifyOnAgentUpdates: true, hiddenFromSidebar: false });
    writeAgentSettings(path, { notifyOnAgentUpdates: false, hiddenFromSidebar: true });
    assert.deepEqual(agentSettingsAt(path), { notifyOnAgentUpdates: false, hiddenFromSidebar: true });
    writeFileSync(path, '{"notifyOnAgentUpdates": "yes", "unknown": 1}');
    assert.deepEqual(agentSettingsAt(path), { notifyOnAgentUpdates: true, hiddenFromSidebar: false });
  });
});

describe("an agent's profile", () => {
  it("is one file beside the agent, and no file is no profile", () => {
    assert.equal(SLATE_PROFILE_FILENAME, "profile.json");
    assert.equal(getSlateProfilePath("/agents/a1"), "/agents/a1/profile.json");
    assert.equal(readSlateProfileFile(join(scratch, "no-profile")), null);
  });
});

describe("the managed-setup ports", () => {
  it("asks for a token best-effort, so a caller that cannot get one gets nothing", async () => {
    const works: Pick<ManagedAuthPort, "getAccessToken"> = { getAccessToken: async () => "token" };
    const fails: Pick<ManagedAuthPort, "getAccessToken"> = { getAccessToken: async () => { throw new Error("not signed in"); } };
    assert.equal(await bestEffortAccessToken(works)(), "token");
    assert.equal(await bestEffortAccessToken(fails)(), null);
  });
});

describe("staging an upgrade for the supervisor", () => {
  it("writes where the supervisor reads, and names the command path", () => {
    assert.equal(SLATE_SUPERVISOR_DIR, "/tmp/slate-supervisor");
    assert.equal(SLATE_SUPERVISOR_COMMAND_PATH, "/tmp/slate-supervisor/command.json");
  });
});

describe("where a connector's secrets are kept", () => {
  it("writes one file per agent and platform, and treats what it cannot read as no secrets", () => {
    const store = new SlateConnectorSecretStore(join(scratch, "secrets"));
    const path = store.filePath("a1", "linear");
    assert.equal(path.startsWith(join(scratch, "secrets", "a1")), true);
    assert.equal(store.setSecret("a1", "linear", "token", "secret"), true);
    assert.deepEqual(store.read("a1", "linear"), { token: "secret" });
    assert.equal(store.setSecret("a1", "linear", "extra", "more"), true);
    assert.deepEqual(store.read("a1", "linear"), { token: "secret", extra: "more" });
    assert.equal(store.setSecret("a1", "linear", "", "nope"), false);
    assert.equal(store.setSecret("../escape", "linear", "token", "nope"), false);
    assert.deepEqual(store.read("a1", "slack"), {});
    writeFileSync(path, "{not json");
    assert.deepEqual(store.read("a1", "linear"), {});
  });
});

describe("packing a box's store", () => {
  it("bounds a member, and names where the pack index lives", () => {
    assert.equal(PACK_INDEX_VERSION, 1);
    assert.equal(PACK_MEMBER_MAX_BYTES, 8 * 1024 * 1024);
    assert.equal(BOX_STORE_PACK_INDEX_KEY, "packs/index.json");
  });
});

describe("the codebase-telemetry helper", () => {
  it("is looked for beside the host bundle unless an override names it", () => {
    assert.equal(csnapsPath({ SLATE_CSNAPS_BIN: "/opt/csnaps" } as NodeJS.ProcessEnv), "/opt/csnaps");
    assert.match(csnapsPath({} as NodeJS.ProcessEnv), /extensions\/codebase-telemetry\/csnaps$/);
  });
});

describe("rooms that were torn down", () => {
  it("names a tombstone by its room and the owner it belonged to", () => {
    assert.equal(tombstoneKey({ roomId: "r1", ownerAuthId: "o1" }), "o1\0r1");
    assert.equal(tombstoneKey({ roomId: "r1" }), "\0r1");
  });
});

describe("rendering a video for playback", () => {
  it("bounds the cache, the run and the retry after a failure", () => {
    assert.equal(VIDEO_TOOL_TIMEOUT_MS, 120_000);
    assert.equal(MAX_CACHED_RENDITIONS, 8);
    assert.equal(FAILED_RESOLUTION_RETRY_MS, 30_000);
  });
});

describe("when a room may be shared with someone else's computer", () => {
  it("is off on a development host, and needs both switches against the production backend", () => {
    assert.equal(SLATE_DEV_XUSER_SHARING_ENV, "SLATE_DEV_XUSER_SHARING");
    assert.equal(SLATE_XUSER_SHARING_ALLOW_PROD_ENV, "SLATE_XUSER_SHARING_ALLOW_PROD");
    assert.equal(isProductionBackendUrl("https://api.slate.invalid"), true);
    assert.equal(isProductionBackendUrl("https://dev-staging.slate.invalid"), false);
    assert.equal(resolveXuserSharingEnvironment({ backendUrl: "https://api.slate.invalid", env: {} as NodeJS.ProcessEnv }).isAllowed, false);
  });
});

describe("the notices a routine earns", () => {
  it("knows the one notice it raises, and how old an automation has to be for it", () => {
    assert.equal(GITHUB_LISTENER_SCOPE, "github-listener-scope");
    assert.equal(GITHUB_LISTENER_SCOPE_CREATED_BEFORE_MS, Date.UTC(2026, 6, 30));
    assert.equal(isRoutineNoticeId("github-listener-scope"), true);
    assert.equal(isRoutineNoticeId("something-else"), false);
  });
});

describe("reminding an agent to say something", () => {
  it("waits for several tool calls, and marks the reminder as hidden", () => {
    assert.equal(SLATE_SEND_MESSAGE_TOOL_NAME, "SendMessage");
    assert.equal(DEFAULT_SEND_MESSAGE_REMINDER_THRESHOLD, 6);
    assert.equal(DEFAULT_EARLY_RESULT_REMINDER_THRESHOLD, 0);
    assert.equal(SEND_MESSAGE_REMINDER_MESSAGE.startsWith("<system_reminder>"), true);
  });
});

describe("what the telemetry modules report", () => {
  it("uses our own event names and the level each outcome implies", () => {
    assert.equal(AUTOMATION_SHADOW_PRUNE_EVENT, "slate.automation.shadow_prune");
    assert.equal(automationShadowPruneTelemetry({ outcome: "failed", conversationId: "c", automationId: "a", localDefinitionState: "present", localDefinitionCount: 1, desiredCount: 1, remoteShadowCount: 2 }).level, "warn");
    assert.equal(automationShadowPruneTelemetry({ outcome: "pruned", conversationId: "c", automationId: "a", localDefinitionState: "absent", localDefinitionCount: 0, desiredCount: 0, remoteShadowCount: 0 }).level, "info");
    assert.equal(TURN_EMPTY_DELIVERY_EVENT, "slate.turn.empty_delivery");
    assert.equal(JOURNAL_OUTCOME_EVENT, "slate.journal.outcome");
    assert.equal(BOX_LOG_SHIP_EVENT, "slate.box.log_ship");
    assert.equal(SUBAGENT_REVIVAL_EVENT, "slate.subagent.revival");
    assert.equal(SHELL_REVIVAL_EVENT, "slate.shell.revival");
    assert.equal(subagentRevivalTelemetry({}).level, "info");
    assert.equal(HYDRATION_WAIT_MS, 60_000);
  });
});

describe("the contracts the transcript extensions share", () => {
  it("says what is wrong when the runner was never attached", () => {
    assert.equal(RUNNER_UNATTACHED_MESSAGE, "Slate agent runner factory is not attached.");
  });
});
