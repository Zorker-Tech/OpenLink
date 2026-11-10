import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  encodeBoxBlockedMessage,
  findBoxBlockedMessage,
  GATEWAY_BOX_BLOCKED_PREFIX,
  hasBoxBlockedMarker,
} from "../../source/shared/gateway-reachability.ts"

describe("box blocked message marker", () => {
  it("packs the reason, title and detail after the marker in a fixed order", () => {
    const encoded = encodeBoxBlockedMessage({ reason: "paused", title: "Stopped", detail: "Try later" })
    assert.equal(encoded, `${GATEWAY_BOX_BLOCKED_PREFIX}paused\u001fStopped\u001fTry later`)
    assert.equal(hasBoxBlockedMarker(encoded), true)
  })

  it("extracts the marker from a nested cause and starts at the marker itself", () => {
    const encoded = encodeBoxBlockedMessage({ reason: "locked", title: "", detail: "" })
    const nested = new Error(`transport wrapper: ${encoded}`)
    const outer = Object.assign(new Error("request failed"), { cause: nested })
    assert.equal(findBoxBlockedMessage(outer), encoded)
  })

  it("stops when a cause chain cycles and returns no marker", () => {
    const cycle = Object.assign(new Error("no marker"), {}) as Error & { cause?: unknown }
    cycle.cause = cycle
    assert.equal(findBoxBlockedMessage(cycle), null)
    assert.equal(hasBoxBlockedMarker("ordinary failure"), false)
  })
})
