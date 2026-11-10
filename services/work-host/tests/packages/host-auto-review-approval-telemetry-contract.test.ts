import assert from "node:assert/strict"
import test from "node:test"

import { autoReviewApprovalTelemetry } from "../../source/host/telemetry/auto-review-approval-telemetry.ts"

const base = {
  eventType: "resolved",
  conversationId: "conversation-3",
  approvalId: "approval-4",
  surface: "desktop",
  status: "approved",
}

test("approval telemetry projects lifecycle identifiers and clamps rounded durations", () => {
  assert.deepEqual(autoReviewApprovalTelemetry({
    ...base,
    ageMs: -1.6,
    ttlMs: 2.6,
    cause: "user_action",
  }), {
    event: "slate.auto_review.approval",
    metadata: {
      event_type: "resolved",
      conversation_id: "conversation-3",
      approval_id: "approval-4",
      surface: "desktop",
      status: "approved",
      age_ms: "0",
      ttl_ms: "3",
      cause: "user_action",
    },
  })
})

test("optional ttl and cause fields are absent when they were not supplied", () => {
  const result = autoReviewApprovalTelemetry({ ...base, ageMs: 5.4 })
  assert.equal(result.metadata.age_ms, "5")
  assert.equal(Object.hasOwn(result.metadata, "ttl_ms"), false)
  assert.equal(Object.hasOwn(result.metadata, "cause"), false)
})
