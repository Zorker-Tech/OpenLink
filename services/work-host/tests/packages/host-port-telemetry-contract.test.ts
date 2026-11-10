import assert from "node:assert/strict"
import { test } from "node:test"

import {
  createNoopSlateTelemetry,
  resolveBoxIdentityTags,
  slateErrorDetail,
  SLATE_BOX_BOOT_FAILURE_REASONS,
  SLATE_BOX_BOOT_STAGES,
  SLATE_COOKIE_PERSIST_OUTCOMES,
  SLATE_EGRESS_TUNNEL_OUTCOMES,
  SLATE_HOST_LIFECYCLE_PHASES,
  SLATE_PROCESS_CRASH_SIGNALS,
} from "../../source/host/ports/telemetry.ts"

test("error details keep the error text and stack, or describe any other value", () => {
  const failure = new Error("disk unavailable")
  assert.deepEqual(slateErrorDetail(failure), { message: "disk unavailable", stack: failure.stack })
  assert.deepEqual(slateErrorDetail({ code: 4 }), { message: "[object Object]" })
  assert.deepEqual(slateErrorDetail(null), { message: "null" })
})

test("box identity tags trim configured values and leave absent values undefined", () => {
  assert.deepEqual(resolveBoxIdentityTags({
    SLATE_BOX_AUTH_ID: " auth-1 ",
    SLATE_BOX_TENANT_ID: "  ",
    SLATE_BOX_STORE_ID: "store-1",
  } as NodeJS.ProcessEnv), {
    auth_id: "auth-1",
    tenant_id: "",
    box_store_id: "store-1",
    box_boot_id: undefined,
    cluster: undefined,
  })
})

test("the no-op telemetry port exposes every reporting method and a harmless turn handle", () => {
  const telemetry = createNoopSlateTelemetry()
  const reporterNames = [
    "reportToolCallError", "reportToolCallStalled", "reportToolCallStarted", "reportAgentError",
    "reportBotBlock", "reportDaemonPing", "reportBoxBootStage", "reportExecDaemonRestart",
    "reportSupervisorRestart", "reportAutomationRun", "reportAutomationFireDropped",
    "reportAutomationLifecycle", "reportTurnInterrupt", "reportTurnAwait", "reportTurnRetry",
    "reportUserMessageReceived", "reportClosingSendNudge", "reportSubagentRevival", "reportShellRevival",
    "reportComputerUseUsage", "reportTtft", "reportSendDispatch", "reportQueueAccepted",
    "reportQueueDequeued", "reportQueueWatchdog", "reportAckObligation", "reportPendingWake",
    "reportTurnUsage", "reportTurnEmptyDelivery", "reportJournalOutcome", "reportAutoReviewExpireSweepFailed",
  ]
  for (const name of reporterNames) {
    const reporter = telemetry[name as keyof typeof telemetry]
    assert.equal(typeof reporter, "function", name)
    if (typeof reporter === "function") Reflect.apply(reporter, undefined, [{}])
  }
  const turn = telemetry.startTurn()
  assert.equal(typeof turn.setModel, "function")
  assert.equal(typeof turn.setRequestId, "function")
  assert.equal(typeof turn.finalize, "function")
  turn.setModel()
  turn.setRequestId()
  turn.finalize()
})

test("telemetry stage lists remain explicit and stable", () => {
  assert.deepEqual(SLATE_BOX_BOOT_STAGES, ["entrypoint_started", "daemon_listening", "desktop_up", "ready"])
  assert.deepEqual(SLATE_BOX_BOOT_FAILURE_REASONS, ["x_display_timeout"])
  assert.deepEqual(SLATE_HOST_LIFECYCLE_PHASES, ["plugin_graph", "identity", "log_catchup", "transcript_read", "ready"])
  assert.equal(SLATE_COOKIE_PERSIST_OUTCOMES.includes("partial"), true)
  assert.equal(SLATE_EGRESS_TUNNEL_OUTCOMES.includes("listener_lost"), true)
  assert.equal(SLATE_PROCESS_CRASH_SIGNALS.includes("sigsegv"), true)
})
