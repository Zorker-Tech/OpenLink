/**
 * The structured log: the one enqueue every report goes through, what each report writes, which transport a host ends
 * up with, and what a turn reports from its first moment to its outcome.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SlateError } from "../../source/shared/errors/registry.ts";
import type { DeadlinePolicy, PollingPolicy } from "../../source/host/extensions/scheduling.ts";
import { StructuredLogTransport } from "../../source/shared/observability/structured-log-transport.ts";
import {
  AGENT_ERROR_DETAIL_EVENT,
  AGENT_ERROR_EVENT,
  AGENT_OPEN_EVENT,
  AUTOMATION_LIFECYCLE_EVENT,
  AUTO_REVIEW_DISPLAY_RECHECK_FAILED_EVENT,
  AUTO_REVIEW_EXPIRE_SWEEP_FAILED_EVENT,
  BOT_BLOCK_DETAIL_EVENT,
  BOT_BLOCK_EVENT,
  BOX_HELP_EVENT,
  BOX_LOG_EVENT,
  BOX_STORE_DB_CAPTURE_EVENT,
  BOX_STORE_MANIFEST_CONFLICT_EVENT,
  BOX_STORE_SYNC_EVENT,
  BOX_BOOT_STAGE_EVENT,
  CHROME_SESSION_STAGE_EVENT,
  CLIENT_RESOURCE_EVENT,
  EGRESS_TUNNEL_EVENT,
  HOST_CRASH_EVENT,
  HOST_INVARIANT_VIOLATION_EVENT,
  HOST_LOG_EVENT,
  HOST_UPGRADE_EVENT,
  MCP_AUTH_CLEANUP_EVENT,
  MCP_DISCOVERY_FAILED_EVENT,
  PLUGIN_SKILLS_SYNC_EVENT,
  SKILL_PUBLISH_EDGE_FAILED_EVENT,
  SLATE_LOG_KEY,
  TEACH_RECORDING_CAP_STOP_FAILED_EVENT,
  TEACH_RECORDING_START_FAILED_EVENT,
  TOOL_CALL_ERROR_EVENT,
  TOOL_CALL_STALLED_EVENT,
  TOOL_CALL_STARTED_EVENT,
  TURN_OUTCOME_DETAIL_EVENT,
  TURN_OUTCOME_EVENT,
  TURN_START_EVENT,
} from "../../source/shared/observability/telemetry-events.ts";
import {
  cappedToolCallMs,
  errorDetailTags,
  getHostBuiltAtMs,
  HOST_BUILT_AT_MS,
  InMemoryStructuredLogTransport,
  MAX_ERROR_DETAIL_MESSAGE_LENGTH,
  MAX_ERROR_DETAIL_STACK_LENGTH,
  MAX_HOST_LOG_LENGTH,
  SlateStructuredLogTelemetry,
  structuredErrorCode,
  TELEMETRY_FLUSH_TICK_MS,
  TOOL_CALL_MS_CAP,
  truncateStructuredLogValue,
} from "../../source/host/telemetry/structured-log-telemetry.ts";

/** A host whose log never leaves memory: every report is readable afterwards. */
function logWorld(identityTags?: Record<string, string | undefined>) {
  const transport = new InMemoryStructuredLogTransport();
  const telemetry = new SlateStructuredLogTelemetry(identityTags === undefined ? { transport } : { transport, identityTags });
  return { telemetry, transport, entries: () => transport.entries };
}

const linesOf = (entries: ReturnType<InMemoryStructuredLogTransport["entries"]["slice"]>) => entries.map((entry) => [entry.level, entry.message]);

/** The two policies a host needs before its logs can leave the machine. */
function shippingPolicies() {
  const policies: PollingPolicy = { name: "flush", start: () => ({ dispose: () => {} }) };
  const deadline: DeadlinePolicy = { name: "submit", run: async (work, _signal) => await work(new AbortController().signal) };
  return { policies, deadline };
}

describe("the values a report may carry", () => {
  it("writes what the caller had as text, and never writes what they did not have", () => {
    const world = logWorld();
    world.telemetry.enqueue("info", "an event", { present: 3, flag: true, missing: undefined, text: "x" });
    assert.deepEqual(world.entries(), [
      { level: "info", message: "an event", metadata: { present: "3", flag: "true", text: "x" } },
    ]);
    // Identity tags arrive first and the report's own values win where they collide.
    const tagged = logWorld({ box_store_id: "store-1", empty: "" });
    assert.deepEqual(tagged.transport.identityTags, { box_store_id: "store-1" });
    tagged.telemetry.enqueue("warn", "an event", { box_store_id: "store-2", other: 1 });
    assert.deepEqual(tagged.entries()[0]!.metadata, { box_store_id: "store-2", other: "1" });
    assert.equal(TELEMETRY_FLUSH_TICK_MS, 3_000);
  });

  it("truncates what it must and caps a tool call's duration", () => {
    assert.equal(truncateStructuredLogValue("abc", 2), "ab");
    assert.equal(truncateStructuredLogValue("abc", 3), "abc");
    assert.equal(MAX_HOST_LOG_LENGTH, 2_048);
    assert.equal(MAX_ERROR_DETAIL_MESSAGE_LENGTH, 1_024);
    assert.equal(MAX_ERROR_DETAIL_STACK_LENGTH, 4_096);
    assert.equal(TOOL_CALL_MS_CAP, 86_400_000);
    assert.deepEqual([cappedToolCallMs(12.6), cappedToolCallMs(-5), cappedToolCallMs(TOOL_CALL_MS_CAP + 1)], ["13", "0", "86400000"]);
    // An error that is not a platform error is reported as the unregistered one.
    assert.equal(structuredErrorCode(new Error("anything")), "SLATE-E0001");
    assert.equal(structuredErrorCode(SlateError.backendHttpStatus()), "SLATE-E0106");
    const tags = errorDetailTags(new Error("anything"), { message: "x".repeat(2_000), stack: "y".repeat(5_000) });
    assert.deepEqual([tags.error_code, tags.error_message.length, tags.error_stack?.length], ["SLATE-E0001", MAX_ERROR_DETAIL_MESSAGE_LENGTH, MAX_ERROR_DETAIL_STACK_LENGTH]);
    assert.equal(errorDetailTags(new Error("anything"), { message: "x" }).error_stack, undefined);
    assert.equal(getHostBuiltAtMs(), HOST_BUILT_AT_MS);
  });
});

describe("what a report writes", () => {
  it("reports a tool call from the fields it was given", () => {
    const world = logWorld();
    world.telemetry.reportToolCallStarted({ conversationId: "c-1", requestId: "r-1", toolName: "read", toolCallId: "call-1", surface: "computer" });
    world.telemetry.reportToolCallStalled({ conversationId: "c-1", toolName: "read", toolCallId: "call-1", connector: "mcp", elapsedMs: 1_500.4 });
    world.telemetry.reportToolCallError({ conversationId: "c-1", requestId: "r-2", toolName: "write", errorClass: "refused", durationMs: -1 });
    assert.deepEqual(linesOf(world.entries()), [["info", TOOL_CALL_STARTED_EVENT], ["warn", TOOL_CALL_STALLED_EVENT], ["error", TOOL_CALL_ERROR_EVENT]]);
    assert.deepEqual(world.entries()[0]!.metadata, { conversation_id: "c-1", request_id: "r-1", tool_name: "read", tool_call_id: "call-1", surface: "computer" });
    assert.deepEqual(world.entries()[1]!.metadata, { conversation_id: "c-1", tool_name: "read", tool_call_id: "call-1", connector: "mcp", elapsed_ms: "1500" });
    assert.deepEqual(world.entries()[2]!.metadata, { conversation_id: "c-1", request_id: "r-2", tool_name: "write", error_class: "refused", duration_ms: "0" });
  });

  it("reports an agent error, and its detail only when the caller had one", () => {
    const world = logWorld();
    world.telemetry.reportAgentError({ source: "poll", conversationId: "c-1", requestId: "r-1", error: SlateError.backendHttpStatus() });
    world.telemetry.reportAgentError({ source: "poll", conversationId: "c-1", error: SlateError.backendHttpStatus(), detail: { message: "boom", stack: "at x" } });
    const error = world.entries()[0]!;
    const detail = world.entries().find((entry) => entry.message === AGENT_ERROR_DETAIL_EVENT)!;
    assert.deepEqual(linesOf(world.entries()), [["error", AGENT_ERROR_EVENT], ["error", AGENT_ERROR_EVENT], ["error", AGENT_ERROR_DETAIL_EVENT]]);
    assert.deepEqual([error.metadata["error_code"], error.metadata["error_domain"], error.metadata["error_retryable"]], ["SLATE-E0106", "transport", "true"]);
    assert.equal(error.metadata["error_message"], undefined);
    assert.deepEqual([detail.metadata["error_message"], detail.metadata["error_stack"]], ["boom", "at x"]);
  });

  it("reports the box store, chrome, mcp and the local tool permission decisions", () => {
    const world = logWorld();
    world.telemetry.reportBoxStoreSyncCycle("info", { cycle: "one" });
    world.telemetry.reportBoxStoreDbCapture("warn", { db: "one" });
    world.telemetry.reportBoxStoreManifestConflict("error", { conflict: "one" });
    world.telemetry.reportChromeSessionStage("info", { stage: "launch" });
    world.telemetry.reportMcpAuthCleanup("ok", 3);
    world.telemetry.reportMcpAuthCleanup("error", 0);
    world.telemetry.reportMcpDiscoveryFailed({ errorClass: "timeout", elapsedMs: 12.4, servedStale: true });
    world.telemetry.reportBoxDiskPressure({ level: "soft", volume: "/workspace", trigger: "watchdog", totalBytes: 1_000, availableBytes: 100, usedPercent: 90 });
    world.telemetry.reportLocalToolPermissionStrandedRetirement();
    assert.deepEqual(linesOf(world.entries()), [
      ["info", BOX_STORE_SYNC_EVENT],
      ["warn", BOX_STORE_DB_CAPTURE_EVENT],
      ["error", BOX_STORE_MANIFEST_CONFLICT_EVENT],
      ["info", CHROME_SESSION_STAGE_EVENT],
      ["info", MCP_AUTH_CLEANUP_EVENT],
      ["warn", MCP_AUTH_CLEANUP_EVENT],
      ["warn", MCP_DISCOVERY_FAILED_EVENT],
      ["warn", "slate.box.disk_pressure"],
      ["warn", CLIENT_RESOURCE_EVENT],
    ]);
    assert.deepEqual(world.entries()[4]!.metadata, { outcome: "ok", removed_count: "3" });
    assert.deepEqual(world.entries()[7]!.metadata, { volume: "/workspace", pressure_level: "soft", trigger: "watchdog", total_bytes: "1000", available_bytes: "100", used_percent: "90.0" });
    assert.deepEqual(world.entries()[6]!.metadata, { error_class: "timeout", elapsed_ms: "12", served_stale: "true" });
    assert.deepEqual(world.entries()[8]!.metadata, { domain: "permissions", operation: "resolveLocalToolPermission", state: "failed", failure_code: "permissions/stranded-ask-retired", boundary: "host", retry_owner: "none" });
  });

  it("reports the skills, the recordings, the lifecycle and the agent's own moments", () => {
    const world = logWorld();
    world.telemetry.reportSkillPublishEdgeFailed({ stage: "publish", errorClass: "refused" });
    world.telemetry.reportPluginSkillsSync({ trigger: "startup", outcome: "synced", changed: true, skillCount: 2, durationMs: 10.6 });
    world.telemetry.reportPluginSkillsSync({ trigger: "auth_change", outcome: "failed", errorClass: "clone_failed", durationMs: 1 });
    world.telemetry.reportTeachRecordingCapStopFailed({ errorClass: "no_session" });
    world.telemetry.reportTeachRecordingStartFailed({ kind: "capture", errorClass: "refused", windowIndex: 2, entryPoint: "tray" });
    world.telemetry.reportAutomationLifecycle({ conversationId: "c-1", automationId: "a-1", action: "created", source: "agent", triggerType: "cron", scheduledFiresNext7Days: 3, firesOnWeekend: false, firesOvernight: null, ageMs: 12, recordedRunCount: 0 });
    world.telemetry.reportAgentOpen({ conversationId: "c-1", durationMs: 5, entryCount: 7, wasActive: false });
    world.telemetry.reportHostCrash("SIGSEGV");
    world.telemetry.reportInvariantViolation({ name: "one-and-only-one" });
    assert.deepEqual(linesOf(world.entries()).map((line) => line[0]), ["warn", "info", "warn", "warn", "warn", "info", "info", "error", "error"]);
    assert.deepEqual(world.entries()[1]!.metadata, { trigger: "startup", outcome: "synced", changed: "true", skill_count: "2", duration_ms: "11" });
    assert.deepEqual(world.entries()[2]!.metadata, { trigger: "auth_change", outcome: "failed", error_class: "clone_failed", duration_ms: "1" });
    assert.deepEqual(world.entries()[4]!.metadata, { kind: "capture", error_class: "refused", window_index: "2", entry_point: "tray" });
    assert.deepEqual(world.entries()[5]!.metadata, { conversation_id: "c-1", automation_id: "a-1", action: "created", source: "agent", trigger_type: "cron", scheduled_fires_next_7_days: "3", fires_on_weekend: "false", age_ms: "12", recorded_run_count: "0" });
    assert.deepEqual(world.entries()[6]!.metadata, { conversation_id: "c-1", duration_ms: "5", entry_count: "7", was_active: "false" });
    assert.deepEqual(world.entries()[7]!.metadata, { kind: "SIGSEGV" });
  });

  it("reports a host log, a box help turn and a blocked page — the last one twice", () => {
    const world = logWorld();
    world.telemetry.reportHostLog("info", "x".repeat(MAX_HOST_LOG_LENGTH + 10), { extra: "kept" });
    world.telemetry.reportBoxHelp({ conversationId: "c-1", snapshotCaptured: true, reason: "user asked" });
    world.telemetry.reportBotBlock({ conversationId: "c-1", family: "cloudflare", confidence: "high", blockedHost: "example.test", blockedUrl: "https://example.test/x" });
    assert.equal(world.entries()[0]!.metadata["text"]?.length, MAX_HOST_LOG_LENGTH);
    assert.equal(world.entries()[0]!.metadata["extra"], "kept");
    assert.deepEqual(world.entries()[1]!.metadata, { conversation_id: "c-1", snapshot_captured: "true", "meta.reason": "user asked" });
    assert.deepEqual(world.entries()[2]!.metadata, { conversation_id: "c-1", family: "cloudflare", confidence: "high" });
    assert.deepEqual(world.entries()[3]!.metadata, { conversation_id: "c-1", family: "cloudflare", blocked_host: "example.test", blocked_url: "https://example.test/x" });
  });

  it("reports an upgrade, an exit and an infrastructure event, and waits for the confirmed ones", async () => {
    const world = logWorld();
    world.telemetry.reportHostUpgrade({ outcome: "failed", from: "old" });
    world.telemetry.reportHostUpgrade({ outcome: "applied", from: "old" });
    world.telemetry.reportBoxBootStage({ stage: "ready", durationMs: 10 });
    world.telemetry.reportEgressTunnel({ outcome: "ready" });
    assert.deepEqual(linesOf(world.entries()).map((line) => line[0]), ["warn", "info", "warn", "info"]);
    assert.equal(await world.telemetry.reportHostUpgradeConfirmed({ outcome: "failed" }), true);
    assert.equal(await world.telemetry.reportBoxBootStageConfirmed({ stage: "ready", durationMs: 10 }), true);
    assert.equal(await world.telemetry.reportHostProcessExitConfirmed({ schemaVersion: 1, errorClass: "signal_exit", exitSignal: "SIGSEGV", crashedAtMs: 5 }), true);
    assert.equal(world.entries().at(-1)!.metadata["error_code"], "SLATE-E0001");
    // An infrastructure event the mapper does not recognise is not a report at all.
    const unknown = logWorld();
    unknown.telemetry.enqueueBoxInfrastructureEvent({ kind: "not_a_kind" } as never);
    assert.deepEqual(unknown.entries(), []);
  });

  it("reports a box log batch entry by entry, and says what became of each", () => {
    const world = logWorld();
    const settled: string[] = [];
    world.telemetry.reportBoxLogBatch(
      [
        { kind: "log", source: "box", line: "hello" },
        { kind: "infrastructure", event: { kind: "boot_stage", stage: "ready" } },
        { kind: "log", source: "box" },
        { kind: "something_else" },
      ],
      (settlement) => void settled.push(settlement),
    );
    assert.deepEqual(world.entries().map((entry) => [entry.message, entry.metadata["text"] ?? entry.metadata["stage"]]), [
      [BOX_LOG_EVENT, "hello"],
      [BOX_BOOT_STAGE_EVENT, "ready"],
      [BOX_LOG_EVENT, ""],
    ]);
    assert.deepEqual(settled, ["delivered", "delivered", "delivered"]);
  });
});

describe("the reports that are entirely a mapper's", () => {
  it("enqueues the level, the event and the metadata the mapper decided on", () => {
    const world = logWorld();
    world.telemetry.reportAutomationRun({ conversationId: "c-1", automationId: "a-1", trigger: "cron", outcome: "ok", isGroup: false, durationMs: 5 });
    world.telemetry.reportHostDiagnostic({ kind: "send_ledger_degraded", stage: "send" });
    world.telemetry.reportHostStartup({ phase: "ready" });
    assert.deepEqual(linesOf(world.entries()), [["info", "slate.automation.run"], ["error", "slate.host.diagnostic"], ["info", "slate.host.startup"]]);
    assert.deepEqual(world.entries()[2]!.metadata, { phase: "ready", host_built_at_ms: HOST_BUILT_AT_MS });
    // A diagnostic the mapper does not recognise is not written.
    const unknown = logWorld();
    unknown.telemetry.reportHostExtensionDiagnostic({ extension: "not_an_extension" } as never);
    assert.deepEqual(unknown.entries(), []);
  });

  it("keeps a retry on the turn that is still running for that conversation", () => {
    const world = logWorld();
    const turn = world.telemetry.startTurn({ conversationId: "c-1", turnType: "user" });
    world.telemetry.reportTurnRetry({ conversationId: "c-1", outcome: "retried", delayMs: 250, cause: "overloaded" });
    world.telemetry.reportTurnRetry({ conversationId: "c-2", outcome: "retried", delayMs: 250 });
    turn.finalize("ok");
    const outcome = world.entries().find((entry) => entry.message === TURN_OUTCOME_EVENT)!;
    assert.deepEqual([outcome.metadata["retry_count"], outcome.metadata["backoff_total_ms"], outcome.metadata["retry_cause"]], ["1", "250", "overloaded"]);
    // A retry that was not a retry is reported but never counted.
    const quiet = logWorld();
    const quietTurn = quiet.telemetry.startTurn({ conversationId: "c-9", turnType: "user" });
    quiet.telemetry.reportTurnRetry({ conversationId: "c-9", outcome: "gave_up" });
    quietTurn.finalize("ok");
    assert.equal(quiet.entries().find((entry) => entry.message === TURN_OUTCOME_EVENT)!.metadata["retry_count"], undefined);
  });
});

describe("which transport a host ends up with", () => {
  it("keeps what it cannot ship in memory, and ships through the real transport when it can", () => {
    const memory = new SlateStructuredLogTelemetry({ identityTags: { box_store_id: "store-1" } });
    assert.equal(memory.transport instanceof InMemoryStructuredLogTransport, true);
    const { policies, deadline } = shippingPolicies();
    const shipped = new SlateStructuredLogTelemetry({ flushPolling: policies, submitDeadline: deadline, createClient: () => ({}) as never, appVersion: "9.9.9" });
    assert.equal(shipped.transport instanceof StructuredLogTransport, true);
    // Holding the flush for the host's identity needs an expiry to hold it for; without one there is no shipping transport.
    const held = new SlateStructuredLogTelemetry({ flushPolling: policies, submitDeadline: deadline, createClient: () => ({}) as never, holdFlushForHostBundleIdentity: true });
    assert.equal(held.transport instanceof InMemoryStructuredLogTransport, true);
    const withExpiry = new SlateStructuredLogTelemetry({ flushPolling: policies, submitDeadline: deadline, createClient: () => ({}) as never, holdFlushForHostBundleIdentity: true, identityHoldExpiry: { arm: () => ({ dispose: () => {} }) } as never });
    assert.equal(withExpiry.transport instanceof StructuredLogTransport, true);
    // The identity the bundle learns later goes to the transport, whenever it is learned.
    memory.setHostBundleIdentity({ hostBundleVersion: "1.2.3", boxStoreId: "store-9" });
    assert.deepEqual((memory.transport as InMemoryStructuredLogTransport).identityTags, { host_bundle_version: "1.2.3", host_built_at_ms: HOST_BUILT_AT_MS, box_store_id: "store-9" });
    assert.equal(SLATE_LOG_KEY, "slate");
  });

  it("keeps the platform's own tags on what it ships, and honours the switch that turns shipping off", () => {
    const { policies, deadline } = shippingPolicies();
    // A client without the policies that pace it is not enough to ship logs.
    const unpaced = new SlateStructuredLogTelemetry({ createClient: () => ({}) as never });
    assert.equal(unpaced.transport instanceof InMemoryStructuredLogTransport, true);
    const shipped = new SlateStructuredLogTelemetry({ flushPolling: policies, submitDeadline: deadline, createClient: () => ({}) as never, appVersion: "9.9.9", identityTags: { box_store_id: "store-1" } });
    const tags = (shipped.transport as StructuredLogTransport)["platformTags"];
    assert.deepEqual([tags["client"], tags["client.type"], tags["app_version"], tags["box_store_id"]], ["slate", "slate", "9.9.9", "store-1"]);
    assert.equal(typeof tags["client_version"], "string");
    assert.equal(tags["arch"], process.arch);
    // The switch that turns telemetry off makes the transport drop, and the caller is told.
    process.env["SLATE_DISABLE_TELEMETRY"] = "1";
    try {
      const off = new SlateStructuredLogTelemetry({ flushPolling: policies, submitDeadline: deadline, createClient: () => ({}) as never });
      const settlements: string[] = [];
      off.enqueue("info", "an event", {}, (settlement) => void settlements.push(settlement));
      assert.deepEqual(settlements, ["dropped"]);
    } finally {
      delete process.env["SLATE_DISABLE_TELEMETRY"];
    }
  });

  it("answers what the transport said about the reports it had to confirm", async () => {
    const answers: string[] = [];
    const transport = {
      enqueue: () => {},
      shipConfirmed: async (level: string, message: string) => {
        answers.push(`${level}:${message}`);
        return false;
      },
      setIdentityTags: () => {},
      setFlushTickListener: () => {},
      dispose: async () => {},
    };
    const telemetry = new SlateStructuredLogTelemetry({ transport: transport as never });
    assert.equal(await telemetry.reportBoxBootStageConfirmed({ stage: "ready", durationMs: 1 }), false);
    assert.equal(await telemetry.reportHostUpgradeConfirmed({ outcome: "failed" }), false);
    assert.equal(await telemetry.reportHostProcessExitConfirmed({ schemaVersion: 1, errorClass: "signal_exit", exitSignal: "SIGSEGV", crashedAtMs: 5 }), false);
    assert.deepEqual(answers.map((answer) => answer.split(":")[0]), ["warn", "warn", "error"]);
  });

  it("uses the transport it was handed, and lets it go when the host does", async () => {
    const transport = new InMemoryStructuredLogTransport();
    const telemetry = new SlateStructuredLogTelemetry({ transport, identityTags: { client: "slate" } });
    assert.equal(telemetry.transport, transport);
    assert.deepEqual(transport.identityTags, { client: "slate" });
    const ticks: number[] = [];
    telemetry.setFlushTickListener(() => void ticks.push(1));
    transport.tick();
    assert.deepEqual(ticks, [1]);
    await telemetry.dispose();
  });
});

describe("a turn's own lifecycle", () => {
  it("starts once it knows its model, and only once", () => {
    const world = logWorld();
    const unknown = world.telemetry.startTurn({ conversationId: "c-1", turnType: "user" });
    assert.deepEqual(world.entries(), []);
    unknown.setModel("");
    assert.deepEqual(world.entries(), []);
    unknown.setModel("slate-4.5");
    unknown.setModel("other");
    unknown.finalize("ok");
    assert.deepEqual(linesOf(world.entries()).map((line) => line[1]), [TURN_START_EVENT, TURN_OUTCOME_EVENT]);
    assert.deepEqual(world.entries()[0]!.metadata, { turn_type: "user", conversation_id: "c-1", model_intent: "slate-4.5" });
    // A turn that knew its model from the start starts at once, and keeps the first request that asked.
    const known = logWorld();
    const turn = known.telemetry.startTurn({ conversationId: "c-2", turnType: "user", model: "slate-4.5" });
    turn.setRequestId("r-1");
    turn.setRequestId("r-2");
    assert.deepEqual(known.entries().map((entry) => [entry.message, entry.metadata["request_id"]]), [[TURN_START_EVENT, undefined]]);
    // The request the turn is known by shows up in what it reports from then on.
    turn.finalize("ok");
    assert.equal(known.entries()[1]!.metadata["request_id"], "r-1");
  });

  it("ends once, with the outcome the caller gave or the error it carried", () => {
    const world = logWorld();
    const turn = world.telemetry.startTurn({ conversationId: "c-1", turnType: "user", model: "slate-4.5" });
    turn.finalize("cancelled");
    turn.finalize("ok");
    assert.deepEqual(linesOf(world.entries()).map((line) => line[1]), [TURN_START_EVENT, TURN_OUTCOME_EVENT]);
    assert.equal(world.entries()[1]!.metadata["outcome"], "cancelled");
    assert.equal(typeof world.entries()[1]!.metadata["duration_ms"], "string");
    // A turn that carried an error ended in one, and says what the error was.
    const failed = logWorld();
    const failedTurn = failed.telemetry.startTurn({ conversationId: "c-1", turnType: "user", model: "m" });
    failedTurn.noteRetry({ delayMs: 100, cause: "overloaded" });
    failedTurn.finalize("ok", SlateError.backendHttpStatus(), { message: "boom", stack: "at y" });
    failedTurn.noteRetry({ delayMs: 1_000 });
    assert.deepEqual(linesOf(failed.entries()).map((line) => line[1]), [TURN_START_EVENT, TURN_OUTCOME_EVENT, TURN_OUTCOME_DETAIL_EVENT]);
    const outcome = failed.entries()[1]!.metadata;
    assert.deepEqual([outcome["outcome"], outcome["error_code"], outcome["retry_count"], outcome["backoff_total_ms"]], ["error", "SLATE-E0106", "1", "100"]);
    assert.deepEqual([failed.entries()[2]!.metadata["error_message"], failed.entries()[2]!.metadata["error_stack"]], ["boom", "at y"]);
    // A retry that arrived after the turn ended is not counted: the turn it belonged to is over.
    const accounting = failedTurn as unknown as { retryCount: number; backoffTotalMs: number };
    assert.deepEqual([accounting.retryCount, accounting.backoffTotalMs], [1, 100]);
    // An error with no detail is not a detail event, and neither is a detail with nothing that failed.
    const bare = logWorld();
    bare.telemetry.startTurn({ conversationId: "c-1", turnType: "user", model: "m" }).finalize("ok", SlateError.backendHttpStatus());
    assert.deepEqual(linesOf(bare.entries()).map((line) => line[1]), [TURN_START_EVENT, TURN_OUTCOME_EVENT]);
    const detailOnly = logWorld();
    detailOnly.telemetry.startTurn({ conversationId: "c-1", turnType: "user", model: "m" }).finalize("ok", undefined, { message: "not an error" });
    assert.deepEqual(linesOf(detailOnly.entries()).map((line) => line[1]), [TURN_START_EVENT, TURN_OUTCOME_EVENT]);
  });

  it("keeps a conversation's current turn, and lets a finished one go only if it is still current", () => {
    const world = logWorld();
    const first = world.telemetry.startTurn({ conversationId: "c-1", turnType: "user", model: "m" });
    const second = world.telemetry.startTurn({ conversationId: "c-1", turnType: "user", model: "m" });
    assert.equal(world.telemetry.activeTurnsByConversation.get("c-1"), second);
    // The turn that was replaced finishes without taking the newer one with it.
    first.finalize("ok");
    assert.equal(world.telemetry.activeTurnsByConversation.get("c-1"), second);
    second.finalize("ok");
    assert.equal(world.telemetry.activeTurnsByConversation.has("c-1"), false);
  });
});
