import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createContext } from "../../source/packages/context/context.ts"
import {
  getInvocationId,
  getInvocationIdFromRequestId,
  invocationIdGeneratorKey,
} from "../../source/packages/agent/utils/invocation-id.ts"

function hasSuffix(id: string, requestId: string, invocationNumber: number): boolean {
  const prefix = `${requestId}-${invocationNumber}-`
  return id.startsWith(prefix) && /^[a-z0-9]{4}$/.test(id.slice(prefix.length))
}

describe("invocation identifiers", () => {
  it("counts runs per request and keeps an independent four-character suffix", () => {
    const requestId = `request-${crypto.randomUUID()}`
    const otherRequestId = `request-${crypto.randomUUID()}`
    const first = getInvocationIdFromRequestId(requestId)
    const other = getInvocationIdFromRequestId(otherRequestId)
    const second = getInvocationIdFromRequestId(requestId)

    assert.equal(hasSuffix(first, requestId, 0), true)
    assert.equal(hasSuffix(other, otherRequestId, 0), true)
    assert.equal(hasSuffix(second, requestId, 1), true)
    assert.notEqual(first, second)
  })

  it("lets a context provide a deterministic generator", () => {
    const context = createContext().with(invocationIdGeneratorKey, () => "test-invocation")
    assert.equal(getInvocationId(context), "test-invocation")
  })
})
