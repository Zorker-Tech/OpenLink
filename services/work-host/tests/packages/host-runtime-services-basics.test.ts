/**
 * The host's runtime pieces, fourth group: remote group members, database recovery, the journal codec's
 * refusals, the box's markers and windows, the team-rules model, and the telemetry the host reports.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { SHARED_ROOM_MEMBER_TURN_TIMEOUT_MS, SHARED_ROOM_TURN_MESSAGE_LIMIT, SHARED_ROOM_TEXT_LIMIT, sharedRoomBoxToolsAreEnabled } from "../../source/host/groups/xuser.ts";
import { removePathWithRetries, removeSqliteSidecars } from "../../source/host/storage/sqlite-recovery.ts";
import { TranscriptJournalCorruptionError, TranscriptJournalWriteError, TranscriptOccurrenceConflictError } from "../../source/host/transcript/mirror/transcript-journal-codec.ts";
import { applyWebAuthnProxyMarker, BOX_CHROME_POLICY_COMMAND, SLATE_WEBAUTHN_PROXY_MARKER_PATH } from "../../source/host/extensions/webauthn-proxy/webauthn-proxy-marker.ts";
import { hostDiagnosticTelemetry, HOST_DIAGNOSTIC_EVENT } from "../../source/host/telemetry/host-diagnostic-telemetry.ts";
import { DOUBLE_BIND_MESSAGE, TurnExecutionRegistry, UNBOUND_EXECUTION_MESSAGE } from "../../source/host/extensions/turn-execution/turn-execution-service.ts";
import { MAX_ACTIVITY_DETAIL_CHARS, SLATE_BOX_SHELL_TOOL_NAME, SLATE_EXTERNAL_SHELL_TOOL_NAME, SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME, THINKING_ACTIVITY } from "../../source/host/slate-activity.ts";
import { appliesToSlate, directMemberTeamIds, mergeRulesByFullPath, TeamRuleAgentType, TEAM_RULES_REQUEST_TIMEOUT_MS } from "../../source/host/extensions/managed-setup/team-rules.ts";
import { searchIndexHealthTelemetry, SEARCH_INDEX_HEALTH_EVENT } from "../../source/host/telemetry/search-index-health-telemetry.ts";
import { NeverRecords, sendTraceSampler, FollowsItsParent, SampleDecision } from "../../source/host/telemetry/send-trace-sampler.ts";
import { isBackgroundAutomationTrigger, normalizeAutomationErrorKind } from "../../source/host/transcript/slate-automation-failure.ts";
import { DISK_PRESSURE_HEARTBEAT_MS, DISK_PRESSURE_THRESHOLDS, GIB } from "../../source/host/boxes/forever-box/disk-pressure-guard.ts";
import { agentProjectMembershipPath, AGENT_PROJECTS_FILE } from "../../source/host/memory/project-membership.ts";
import { decodeProjectMembership } from "../../source/host/memory/project-membership-policy.ts";
import { BoxFileTransferError } from "../../source/host/boxes/box-file-transfer.ts";
import { computerUseSubagentDescription, COMPUTER_USE_SUBAGENT_TYPE, isComputerUseSubagentType } from "../../source/host/runner/tools/slate-computer-use-subagent.ts";
import { autoReviewApprovalTelemetry } from "../../source/host/telemetry/auto-review-approval-telemetry.ts";
import { MAX_DOMAIN_LENGTH, SNAPSHOT_TIMEOUT_MS } from "../../source/host/extensions/session/box-handoff-service.ts";
import { diskPressureReport, severityOf } from "../../source/host/telemetry/disk-pressure-telemetry.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-host-runtime-4-"));
after(() => { rmSync(scratch, { recursive: true, force: true }); });

describe("a group room that includes someone else's computer", () => {
  it("bounds what a remote member is shown, and keeps the box's tools on unless they were turned off", () => {
    assert.equal(SHARED_ROOM_MEMBER_TURN_TIMEOUT_MS, 600_000);
    assert.equal(SHARED_ROOM_TURN_MESSAGE_LIMIT, 24);
    assert.equal(SHARED_ROOM_TEXT_LIMIT, 8_000);
    assert.equal(sharedRoomBoxToolsAreEnabled(undefined), true);
    assert.equal(sharedRoomBoxToolsAreEnabled(""), true);
    assert.equal(sharedRoomBoxToolsAreEnabled("1"), true);
    assert.equal(sharedRoomBoxToolsAreEnabled("yes"), true);
    assert.equal(sharedRoomBoxToolsAreEnabled("off"), true);
    assert.equal(sharedRoomBoxToolsAreEnabled("0"), false);
    assert.equal(sharedRoomBoxToolsAreEnabled("FALSE"), false);
  });
});

describe("recovering a database that was left behind", () => {
  it("takes the sidecar files with it, and gives a held path a few tries", () => {
    const dbPath = join(scratch, "store.db");
    writeFileSync(dbPath, "db");
    for (const suffix of ["-wal", "-shm", "-journal"]) writeFileSync(`${dbPath}${suffix}`, "x");
    removeSqliteSidecars(dbPath);
    assert.deepEqual(["-wal", "-shm", "-journal"].filter((suffix) => existsSync(`${dbPath}${suffix}`)), []);
    assert.equal(existsSync(dbPath), true);
    const dir = join(scratch, "held");
    mkdirSync(dir, { recursive: true });
    removePathWithRetries({ path: dir, recursive: true });
    assert.equal(existsSync(dir), false);
    let calls = 0;
    removePathWithRetries({ path: join(scratch, "never-there"), attempts: 3, retryDelayMs: 1 });
    while (calls++ < 1) break;
    assert.equal(TranscriptJournalCorruptionError.name, "TranscriptJournalCorruptionError");
    assert.equal(new TranscriptJournalWriteError().name, "TranscriptJournalWriteError");
    assert.equal(new TranscriptOccurrenceConflictError().name, "TranscriptOccurrenceConflictError");
  });
});

describe("the box's security-key marker", () => {
  it("leaves a directory that is not a box's alone, and answers for a marker already in the wanted state", () => {
    assert.equal(SLATE_WEBAUTHN_PROXY_MARKER_PATH, "/home/box/.slate-webauthn-proxy-enabled");
    assert.equal(BOX_CHROME_POLICY_COMMAND, "/usr/local/bin/box-chrome-policy");
    assert.equal(applyWebAuthnProxyMarker(true, join(scratch, "no-such-dir", "marker")), "not-a-box");
    const marker = join(scratch, "box", "marker");
    mkdirSync(join(scratch, "box"), { recursive: true });
    assert.equal(applyWebAuthnProxyMarker(false, marker, "/bin/true"), "unchanged");
  });
});

describe("what the host reports about itself", () => {
  it("reports a degraded send ledger as an error and the rest as a warning", () => {
    assert.equal(HOST_DIAGNOSTIC_EVENT, "slate.host.diagnostic");
    assert.deepEqual(hostDiagnosticTelemetry({ kind: "send_ledger_degraded", stage: "append", agentId: "a1", reason: "busy" }), {
      level: "error",
      event: "slate.host.diagnostic",
      metadata: { kind: "send_ledger_degraded", stage: "append", agent_id: "a1", reason: "busy", error_class: undefined },
    });
    assert.equal(hostDiagnosticTelemetry({ kind: "wake_dropped" }).level, "warn");
  });

  it("reports the search index's health, with the kinds that are only a warning named", () => {
    assert.equal(SEARCH_INDEX_HEALTH_EVENT, "slate.search_index.health");
    assert.equal(searchIndexHealthTelemetry({ kind: "job_retry", count: 3 }).level, "warn");
    assert.equal(searchIndexHealthTelemetry({ kind: "dispose_drain_cut" }).level, "warn");
    const report = searchIndexHealthTelemetry({ kind: "index_write", stage: "flush", errorClass: "ENOSPC", count: 7 });
    assert.equal(report.level, "error");
    assert.deepEqual(report.metadata, { kind: "index_write", stage: "flush", error_class: "ENOSPC", count: "7" });
  });

  it("reports an auto-review approval's lifecycle with its counts as strings", () => {
    const report = autoReviewApprovalTelemetry({ eventType: "expired", conversationId: "c1", approvalId: "r1", surface: "chat", status: "pending", ageMs: 1234.6 });
    assert.equal(report.event, "slate.auto_review.approval");
    assert.equal(report.metadata.age_ms, "1235");
    assert.equal(report.metadata.approval_id, "r1");
  });

  it("reports disk pressure with the level the caller's measurement implies", () => {
    assert.equal(severityOf("hard"), "error");
    assert.equal(severityOf("soft"), "warn");
    assert.equal(severityOf("healthy"), "info");
    const report = diskPressureReport({ level: "soft", volume: "/", trigger: "heartbeat", totalBytes: 100, availableBytes: 12, usedPercent: 88.25 });
    assert.deepEqual(report, {
      level: "warn",
      metadata: { volume: "/", pressure_level: "soft", trigger: "heartbeat", total_bytes: "100", available_bytes: "12", used_percent: "88.3" },
    });
  });
});

describe("the executor a host's turns run on", () => {
  it("refuses a runner before it was bound, and refuses a second bind", () => {
    const registry = new TurnExecutionRegistry();
    assert.equal(registry.canExecute, false);
    assert.throws(() => registry.createRunner({}, {}), (error: unknown) => (error as Error).message === UNBOUND_EXECUTION_MESSAGE);
    const executor = { isInferenceReady: async () => true, createRunner: () => "runner", createGroupMemberRunner: () => "member-runner" };
    registry.bindExecutor(executor);
    assert.equal(registry.canExecute, true);
    assert.equal(registry.createRunner({}, {}), "runner");
    assert.throws(() => registry.bindExecutor(executor), (error: unknown) => (error as Error).message === DOUBLE_BIND_MESSAGE);
  });

  it("answers readiness from the bound executor, and answers no before one is bound", async () => {
    const registry = new TurnExecutionRegistry();
    assert.equal(await registry.isRunReady(), false, "nothing can run before an executor is bound");
    let ready = true;
    const asked: number[] = [];
    const executor = {
      isInferenceReady: async (...args: unknown[]) => { asked.push(args.length); return ready; },
      createRunner: () => "runner",
      createGroupMemberRunner: () => "member-runner",
    };
    registry.bindExecutor(executor);
    assert.equal(await registry.isRunReady(), true);
    ready = false;
    assert.equal(await registry.isRunReady(), false);
    assert.deepEqual(asked, [0, 0], "the bound executor is asked with no arguments");
    const failure = new Error("inference is down");
    const broken = { isInferenceReady: async () => { throw failure; }, createRunner: () => "runner", createGroupMemberRunner: () => "member-runner" };
    const brokenRegistry = new TurnExecutionRegistry();
    brokenRegistry.bindExecutor(broken);
    await assert.rejects(brokenRegistry.isRunReady(), (error: unknown) => error === failure);
  });

  it("mints both kinds of runner on the bound executor, with the executor as the receiver", () => {
    const seen: Array<[string, boolean, number]> = [];
    const session = { conversationId: "c1" };
    const hooks = { onTurn: () => undefined };
    const overrides = { model: "slate" };
    const executor = {
      isInferenceReady: async () => true,
      createRunner(...args: unknown[]) { seen.push(["createRunner", this === executor, args.length]); return { runner: args[0] === session && args[1] === hooks }; },
      createGroupMemberRunner(...args: unknown[]) { seen.push(["createGroupMemberRunner", this === executor, args.length]); return { runner: args[0] === session && args[1] === hooks && args[2] === overrides }; },
    };
    const registry = new TurnExecutionRegistry();
    registry.bindExecutor(executor);
    assert.deepEqual(registry.createRunner(session, hooks), { runner: true });
    assert.deepEqual(registry.createGroupMemberRunner(session, hooks, overrides), { runner: true });
    assert.deepEqual(seen, [["createRunner", true, 2], ["createGroupMemberRunner", true, 3]]);
  });

  it("keeps the first executor when the second bind is refused, and reads canExecute without asking it", () => {
    const first = { isInferenceReady: async () => true, createRunner: () => "first", createGroupMemberRunner: () => "first-member" };
    const second = { isInferenceReady: async () => true, createRunner: () => "second", createGroupMemberRunner: () => "second-member" };
    const registry = new TurnExecutionRegistry();
    registry.bindExecutor(first);
    assert.throws(() => registry.bindExecutor(second), (error: unknown) => error instanceof Error && error.name === "Error" && error.message === DOUBLE_BIND_MESSAGE);
    assert.equal(registry.createRunner({}, {}), "first");
    assert.equal(registry.createGroupMemberRunner({}, {}, {}), "first-member");
    assert.deepEqual(Object.keys(registry), ["executor"], "the bound slot is the one own property an instance has");
    assert.equal(new TurnExecutionRegistry().canExecute, false, "a second registry is not bound by the first");
  });

  it("refuses a group-member runner before it was bound, with the same message", () => {
    const registry = new TurnExecutionRegistry();
    assert.throws(() => registry.createGroupMemberRunner({}, {}, {}), (error: unknown) => error instanceof Error && error.message === UNBOUND_EXECUTION_MESSAGE);
    assert.equal(registry.canExecute, false);
  });
});

describe("what an agent is doing right now", () => {
  it("bounds what it says and knows the tools it names", () => {
    assert.equal(MAX_ACTIVITY_DETAIL_CHARS, 80);
    assert.deepEqual(THINKING_ACTIVITY, { kind: "thinking" });
    assert.equal(SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME, "SendMessage");
    assert.equal(SLATE_BOX_SHELL_TOOL_NAME, "Shell");
    assert.equal(SLATE_EXTERNAL_SHELL_TOOL_NAME, "ExternalShell");
  });
});

describe("the rules a team set", () => {
  it("keeps the ones for this platform, and the first rule at a path wins", () => {
    assert.equal(TEAM_RULES_REQUEST_TIMEOUT_MS, 10_000);
    assert.equal(TeamRuleAgentType.OTHER, 3);
    assert.equal(appliesToSlate({ agentType: TeamRuleAgentType.ALL }), true);
    assert.equal(appliesToSlate({ agentType: TeamRuleAgentType.SLATE }), true);
    assert.equal(appliesToSlate({ agentType: TeamRuleAgentType.OTHER }), false);
    assert.equal(appliesToSlate({ agentType: TeamRuleAgentType.UNSPECIFIED }), false);
    assert.deepEqual(directMemberTeamIds({ teams: [{ id: 4, isDirectMember: true }, { id: 0, isDirectMember: true }, { id: 5, isDirectMember: false }] }), [4]);
    const merged = mergeRulesByFullPath([
      [{ fullPath: "/a", content: "first" }],
      [{ fullPath: "/a", content: "second" }, { fullPath: "/b", content: "third" }],
    ]);
    assert.deepEqual(merged.map((rule) => rule.content), ["first", "third"]);
  });
});

describe("whether a send is traced", () => {
  it("never records a root of its own", () => {
    const sampler = sendTraceSampler();
    assert.equal(sampler instanceof FollowsItsParent, true);
    assert.equal(sampler.shouldSample().decision, SampleDecision.NOT_RECORD);
    assert.equal(sampler.toString(), "ParentBased{root=AlwaysOffSampler}");
    assert.equal(new NeverRecords().toString(), "AlwaysOffSampler");
    assert.equal(SampleDecision.RECORD_AND_SAMPLED, 2);
  });
});

describe("an automation that failed", () => {
  it("knows a background trigger, and reads a detail down to the kind of failure", () => {
    assert.equal(isBackgroundAutomationTrigger("schedule"), true);
    assert.equal(isBackgroundAutomationTrigger("event"), true);
    assert.equal(isBackgroundAutomationTrigger("manual"), false);
    assert.equal(normalizeAutomationErrorKind(undefined), "unknown");
    assert.equal(normalizeAutomationErrorKind("   "), "unknown");
    assert.equal(normalizeAutomationErrorKind("Failed (timeout) at 0x1f for 42"), "failed at for");
    assert.equal(normalizeAutomationErrorKind("Error: connection reset by peer 3 times"), "error connection reset by peer times");
    assert.equal(normalizeAutomationErrorKind("550e8400-e29b-41d4-a716-446655440000 failure"), "failure");
  });
});

describe("noticing that the disk is filling up", () => {
  it("puts the recovery thresholds above the entry ones, so the level does not oscillate", () => {
    assert.equal(GIB, 1024 ** 3);
    assert.equal(DISK_PRESSURE_HEARTBEAT_MS, 300_000);
    const t = DISK_PRESSURE_THRESHOLDS;
    assert.equal(t.softAvailableBytes > t.hardAvailableBytes, true);
    assert.equal(t.softRecoveryBytes > t.softAvailableBytes, true);
    assert.equal(t.hardRecoveryBytes > t.hardAvailableBytes, true);
    assert.equal(t.softRecoveryRatio > t.softAvailableRatio, true);
    assert.equal(t.hardRecoveryRatio > t.hardAvailableRatio, true);
  });
});

describe("which projects an agent is a member of", () => {
  it("keeps only safe folder slugs, and keeps them beside the agent", () => {
    assert.equal(AGENT_PROJECTS_FILE, "projects.json");
    assert.equal(agentProjectMembershipPath("/agents/a1"), "/agents/a1/projects.json");
    assert.deepEqual([...decodeProjectMembership(["safe-slug", "../escape", "", 7, "another_one"])], ["safe-slug", "another_one"]);
    assert.deepEqual([...decodeProjectMembership("not an array")], []);
  });
});

describe("moving a file through a box", () => {
  it("names its refusals, and bounds what it will carry", () => {
    assert.equal(new BoxFileTransferError("nope").name, "BoxFileTransferError");
  });
});

describe("the subagent that drives the box's desktop", () => {
  it("matches its type however it is spelled, and points at the page-level subagent when one is offered", () => {
    assert.equal(COMPUTER_USE_SUBAGENT_TYPE, "computerUse");
    assert.equal(isComputerUseSubagentType("computer_use"), true);
    assert.equal(isComputerUseSubagentType("Computer-Use"), true);
    assert.equal(isComputerUseSubagentType("browserUse"), false);
    assert.equal(isComputerUseSubagentType(undefined), false);
    const alone = computerUseSubagentDescription(false);
    const withBrowser = computerUseSubagentDescription(true);
    assert.equal(alone.includes("browser"), false);
    assert.equal(withBrowser.includes("page"), true);
  });
});

describe("handing a session from one box to another", () => {
  it("bounds what it carries and how long it waits", () => {
    assert.equal(SNAPSHOT_TIMEOUT_MS, 5_000);
    assert.equal(MAX_DOMAIN_LENGTH, 64);
  });
});
