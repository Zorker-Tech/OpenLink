import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  createAnalyticsBufferWireClient,
  encodeAnalyticsBatch,
} from "../../source/adapters/interop/analytics/analytics-client.ts"
import type { AnalyticsBatchRequest } from "../../source/packages/analytics-client/events.ts"
import { TrackEventsRequest } from "../../source/adapters/interop/proto/generated/aiserver/v1/analytics_pb.ts"

describe("the analytics wire adapter", () => {
  const batch: AnalyticsBatchRequest = {
    events: [{
      eventName: "slate.test",
      eventData: { label: "value", count: 3, enabled: true, sequence: 8n },
      timestamp: 1234n,
    }],
  }

  it("converts Slate event records into the external request schema", () => {
    const request = encodeAnalyticsBatch(batch)
    assert.ok(request instanceof TrackEventsRequest)
    const event = request.events[0]
    assert.equal(event?.eventName, "slate.test")
    assert.equal(event?.timestamp, 1234n)
    assert.equal(event?.eventData.label?.data.case, "stringValue")
    assert.equal(event?.eventData.label?.data.value, "value")
    assert.equal(event?.eventData.count?.data.case, "doubleValue")
    assert.equal(event?.eventData.count?.data.value, 3)
    assert.equal(event?.eventData.enabled?.data.case, "boolValue")
    assert.equal(event?.eventData.enabled?.data.value, true)
    assert.equal(event?.eventData.sequence?.data.case, "intValue")
    assert.equal(event?.eventData.sequence?.data.value, 8n)
  })

  it("forwards the converted request and cancellation signal", async () => {
    let seen: unknown
    let seenSignal: AbortSignal | undefined
    const controller = new AbortController()
    const client = createAnalyticsBufferWireClient({
      trackEvents: async (request, options) => {
        seen = request
        seenSignal = options.signal
      },
    })
    await client.trackEvents(batch, { signal: controller.signal })
    assert.ok(seen instanceof TrackEventsRequest)
    assert.equal(seenSignal, controller.signal)
  })
})
