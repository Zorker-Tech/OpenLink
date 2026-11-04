import assert from "node:assert/strict"
import { test } from "node:test"

import type { Clock } from "../../source/host/extensions/scheduling.ts"
import {
  createTransportStageRecorder,
  MAX_IN_FLIGHT_TRANSPORT_REPORTS,
  PENDING_SEND_ECHO_MAX,
  PENDING_SEND_ECHO_TTL_MS,
  SSE_ECHO_STAGE,
} from "../../source/coordinator/telemetry/transport-stage-recorder.ts"
import type { TransportStageEgress, TransportStageReport } from "../../source/coordinator/telemetry/transport-stage-recorder.ts"

function controlledClock(): { clock: Clock; advanceBy(milliseconds: number): void } {
  let epochMs = 1_000
  let monotonicMs = 50
  return {
    clock: {
      now: () => epochMs,
      monotonicNow: () => monotonicMs,
      schedule: () => ({ dispose() {} }),
    },
    advanceBy(milliseconds) {
      epochMs += milliseconds
      monotonicMs += milliseconds
    },
  }
}

function recordingEgress(reports: TransportStageReport[], reportStage?: (report: TransportStageReport) => Promise<unknown>): TransportStageEgress {
  return {
    reportTransportStage: reportStage ?? (async report => { reports.push(report) }),
    reportGatewayCommandSpan: async () => undefined,
    reportGatewayReachability: async () => undefined,
    reportGatewayDnsDiagnostic: async () => undefined,
  }
}

function stageReport(clientNonce: string): TransportStageReport {
  return {
    accountSlot: "account-a",
    clientNonce,
    stage: "request",
    attempt: 1,
    traceparent: null,
    startEpochMs: 0,
    durationMs: 0,
    isError: false,
  }
}

test("a send without a nonce has an inert trace and emits no stage reports", () => {
  const { clock } = controlledClock()
  const reports: TransportStageReport[] = []
  const recorder = createTransportStageRecorder({ clock, egress: recordingEgress(reports) })

  const trace = recorder.beginSend({ accountSlot: "account-a", clientNonce: "", traceparent: "trace-a" })
  trace.beginStage("connect", 1).fail()
  trace.markStage("sent", 2)
  assert.deepEqual(reports, [])
})

test("a stage reports its sampled identity once with wall-clock start and monotonic duration", () => {
  const time = controlledClock()
  const reports: TransportStageReport[] = []
  const recorder = createTransportStageRecorder({ clock: time.clock, egress: recordingEgress(reports) })
  const trace = recorder.beginSend({ accountSlot: "account-a", clientNonce: "nonce-1", traceparent: "trace-a" })
  const stage = trace.beginStage("upload", 3)

  time.advanceBy(17)
  stage.fail()
  stage.complete()

  assert.deepEqual(reports, [{
    accountSlot: "account-a",
    clientNonce: "nonce-1",
    stage: "upload",
    attempt: 3,
    traceparent: "trace-a",
    startEpochMs: 1_000,
    durationMs: 17,
    isError: true,
  }])
})

test("marked stages are immediate and empty trace context is represented as null", () => {
  const time = controlledClock()
  const reports: TransportStageReport[] = []
  const recorder = createTransportStageRecorder({ clock: time.clock, egress: recordingEgress(reports) })
  const trace = recorder.beginSend({ accountSlot: "account-b", clientNonce: "nonce-2", traceparent: "" })

  trace.markStage("connected", 0)
  assert.deepEqual(reports, [{
    accountSlot: "account-b",
    clientNonce: "nonce-2",
    stage: "connected",
    attempt: 0,
    traceparent: null,
    startEpochMs: 1_000,
    durationMs: 0,
    isError: false,
  }])
})

test("a user echo consumes only the matching account and nonce, and emits once", () => {
  const time = controlledClock()
  const reports: TransportStageReport[] = []
  const recorder = createTransportStageRecorder({ clock: time.clock, egress: recordingEgress(reports) })
  recorder.beginSend({ accountSlot: "account-a", clientNonce: "nonce-3", traceparent: "trace-3" })
  recorder.recordSendEcho({ accountSlot: "account-b", clientNonce: "nonce-3" })
  assert.deepEqual(reports, [])

  time.advanceBy(8)
  recorder.recordSendEcho({ accountSlot: "account-a", clientNonce: "nonce-3" })
  recorder.recordSendEcho({ accountSlot: "account-a", clientNonce: "nonce-3" })
  assert.deepEqual(reports, [{
    accountSlot: "account-a",
    clientNonce: "nonce-3",
    stage: SSE_ECHO_STAGE,
    attempt: 0,
    traceparent: "trace-3",
    startEpochMs: 1_008,
    durationMs: 0,
    isError: false,
  }])
})

test("pending echoes survive the exact expiry boundary and are pruned only when older", () => {
  const time = controlledClock()
  const reports: TransportStageReport[] = []
  const recorder = createTransportStageRecorder({ clock: time.clock, egress: recordingEgress(reports) })
  recorder.beginSend({ accountSlot: "account-a", clientNonce: "boundary", traceparent: "trace-boundary" })
  time.advanceBy(PENDING_SEND_ECHO_TTL_MS)
  recorder.recordSendEcho({ accountSlot: "account-a", clientNonce: "boundary" })

  recorder.beginSend({ accountSlot: "account-a", clientNonce: "expired", traceparent: "trace-expired" })
  time.advanceBy(PENDING_SEND_ECHO_TTL_MS + 1)
  recorder.beginSend({ accountSlot: "account-a", clientNonce: "fresh", traceparent: "trace-fresh" })
  recorder.recordSendEcho({ accountSlot: "account-a", clientNonce: "expired" })
  recorder.recordSendEcho({ accountSlot: "account-a", clientNonce: "fresh" })

  assert.deepEqual(reports.map(report => report.clientNonce), ["boundary", "fresh"])
})

test("the pending echo map evicts its oldest entry when the fixed bound is exceeded", () => {
  const { clock } = controlledClock()
  const reports: TransportStageReport[] = []
  const recorder = createTransportStageRecorder({ clock, egress: recordingEgress(reports) })
  for (let index = 0; index <= PENDING_SEND_ECHO_MAX; index += 1) {
    recorder.beginSend({ accountSlot: "account-a", clientNonce: `nonce-${index}`, traceparent: `trace-${index}` })
  }

  recorder.recordSendEcho({ accountSlot: "account-a", clientNonce: "nonce-0" })
  recorder.recordSendEcho({ accountSlot: "account-a", clientNonce: "nonce-1" })
  assert.deepEqual(reports.map(report => report.clientNonce), ["nonce-1"])
})

test("egress respects its in-flight bound and resumes when a report settles", async () => {
  const { clock } = controlledClock()
  let dispatched = 0
  const pending: Array<() => void> = []
  const recorder = createTransportStageRecorder({
    clock,
    egress: recordingEgress([], () => {
      dispatched += 1
      return new Promise<void>(resolve => pending.push(resolve))
    }),
  })

  for (let index = 0; index <= MAX_IN_FLIGHT_TRANSPORT_REPORTS; index += 1) recorder.recordTransportStage(stageReport(`nonce-${index}`))
  assert.equal(dispatched, MAX_IN_FLIGHT_TRANSPORT_REPORTS)

  pending[0]!()
  await Promise.resolve()
  recorder.recordTransportStage(stageReport("after-release"))
  assert.equal(dispatched, MAX_IN_FLIGHT_TRANSPORT_REPORTS + 1)
})

test("synchronous egress failure is swallowed and releases the capacity slot", () => {
  const { clock } = controlledClock()
  let dispatched = 0
  const recorder = createTransportStageRecorder({
    clock,
    egress: recordingEgress([], () => { dispatched += 1; throw new Error("unavailable") }),
  })

  assert.doesNotThrow(() => {
    for (let index = 0; index < MAX_IN_FLIGHT_TRANSPORT_REPORTS + 3; index += 1) recorder.recordTransportStage(stageReport(`nonce-${index}`))
  })
  assert.equal(dispatched, MAX_IN_FLIGHT_TRANSPORT_REPORTS + 3)
})
