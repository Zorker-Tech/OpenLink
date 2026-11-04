import assert from "node:assert/strict"
import { test } from "node:test"

import {
  withAutomationRunAnalytics,
  type AnalyticsClient,
  type TelemetryService,
} from "../../source/host/telemetry/analytics-service.ts"

function telemetryDouble(calls: unknown[][], order?: string[]): TelemetryService {
  return new Proxy({}, {
    get(_target, method: PropertyKey) {
      const name = String(method)
      return (...args: unknown[]) => {
        calls.push([name, ...args])
        order?.push(name)
        return name === "reportAutomationRun" ? "reported" : name
      }
    },
  }) as TelemetryService
}

test("the analytics wrapper forwards the rest of the telemetry surface with its result", () => {
  const forwarded: unknown[][] = []
  const wrapper = withAutomationRunAnalytics(telemetryDouble(forwarded), { trackEvent() {} })
  const invoke = (method: string, ...args: unknown[]) => {
    const candidate = (wrapper as unknown as Record<string, (...values: unknown[]) => unknown>)[method]
    assert.equal(typeof candidate, "function", method)
    if (typeof candidate !== "function") return undefined
    return candidate(...args)
  }

  assert.equal(invoke("startTurn", "agent-1"), "startTurn")
  assert.equal(invoke("reportToolCallError", "agent-1", "failed"), "reportToolCallError")
  assert.deepEqual(forwarded, [
    ["startTurn", "agent-1"],
    ["reportToolCallError", "agent-1", "failed"],
  ])
})

test("automation analytics are emitted before the runtime report, with optional counts omitted when absent", () => {
  const order: string[] = []
  const events: Array<{ name: string; properties: Record<string, string | number | boolean> }> = []
  const analytics: AnalyticsClient = {
    trackEvent(name, properties) { order.push("analytics"); events.push({ name, properties }) },
  }
  const runtimeCalls: unknown[][] = []
  const wrapper = withAutomationRunAnalytics(telemetryDouble(runtimeCalls, order), analytics)
  const send = (wrapper as unknown as { reportAutomationRun(report: unknown): unknown }).reportAutomationRun

  assert.equal(send({
    conversationId: "agent-1",
    automationId: "routine-1",
    trigger: "schedule",
    outcome: "completed",
    isGroup: false,
    sentMessageCount: 0,
  }), "reported")
  assert.deepEqual(events, [{
    name: "slate.automation.run",
    properties: {
      agent_id: "agent-1",
      automation_id: "routine-1",
      trigger: "schedule",
      outcome: "completed",
      is_group: false,
      sent_message_count: 0,
    },
  }])
  assert.deepEqual(order, ["analytics", "reportAutomationRun"])
  assert.equal(runtimeCalls[0]?.[0], "reportAutomationRun")

  events.length = 0
  order.length = 0
  send({
    conversationId: "agent-2",
    automationId: "routine-2",
    trigger: "event",
    outcome: "failed",
    isGroup: true,
  })
  assert.equal("sent_message_count" in (events[0]?.properties ?? {}), false)
})
