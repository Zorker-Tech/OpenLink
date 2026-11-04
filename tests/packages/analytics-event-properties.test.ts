import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { toAnalyticsEventProperties } from "../../source/packages/analytics-client/to-event-data.ts"

describe("Slate analytics event properties", () => {
  it("keeps the primitive values owned by the analytics event contract", () => {
    assert.deepEqual(
      toAnalyticsEventProperties({
        emptyText: "",
        text: "value",
        zero: 0,
        count: 3,
        disabled: false,
        enabled: true,
        emptySequence: 0n,
        sequence: 8n,
        missing: undefined,
        object: { nested: "value" },
        list: ["value"],
        absent: null,
      }),
      { emptyText: "", text: "value", zero: 0, count: 3, disabled: false, enabled: true, emptySequence: 0n, sequence: 8n },
    )
  })

  it("returns a fresh empty value when no properties are supplied", () => {
    assert.deepEqual(toAnalyticsEventProperties(undefined), {})
    assert.notEqual(toAnalyticsEventProperties(null), toAnalyticsEventProperties(null))
  })
})
