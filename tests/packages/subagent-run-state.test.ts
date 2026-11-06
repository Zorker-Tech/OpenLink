import { test } from "node:test"
import assert from "node:assert/strict"

import { updateSlateSubagentRun } from "../../source/packages/agent/subagent-run-state.ts"
import type { SlateBackgroundTaskCompletion } from "../../source/packages/agent/actions/background-task-completion-contracts.ts"

function completion(
  overrides: Partial<SlateBackgroundTaskCompletion> = {},
): SlateBackgroundTaskCompletion {
  return {
    kind: "subagent",
    status: "success",
    taskId: "task-1",
    title: "finished",
    toolCallId: "call-1",
    subagentId: "agent-1",
    ...overrides,
  }
}

test("a completion updates the Slate run record with explicit metadata", () => {
  const updated = updateSlateSubagentRun({
    completion: completion({
      status: "error",
      title: "  finished with a warning  ",
      detail: "  one file failed  ",
      outputPath: "/repo/output.txt",
      reason: "worker-reparented",
    }),
    parentToolCallId: "call-1",
    subagentId: "  agent-1  ",
    environment: "cloud",
    transcriptPath: " /repo/transcript.jsonl ",
    existingRun: {
      parentToolCallId: "call-1",
      environment: "local",
      status: "running",
      title: "old title",
      detail: "old detail",
      transcriptPath: "/repo/old.jsonl",
      completionReason: "task-progress",
    },
    completedTimestampMs: BigInt(42),
  })

  assert.deepEqual(updated, {
    parentToolCallId: "call-1",
    subagentId: "agent-1",
    environment: "cloud",
    status: "error",
    title: "finished with a warning",
    detail: "one file failed",
    transcriptPath: "/repo/transcript.jsonl",
    outputPath: "/repo/output.txt",
    completedTimestampMs: BigInt(42),
    completionReason: "worker-reparented",
  })
})

test("unknown completion fields preserve what the run already learned", () => {
  const updated = updateSlateSubagentRun({
    completion: completion({
      status: "unknown",
      title: " ",
      detail: "",
      outputPath: undefined,
      reason: undefined,
    }),
    parentToolCallId: "call-1",
    environment: "unspecified",
    existingRun: {
      parentToolCallId: "call-1",
      subagentId: "agent-existing",
      environment: "cloud",
      status: "backgrounded",
      title: "existing title",
      detail: "existing detail",
      transcriptPath: "/repo/transcript.jsonl",
      outputPath: "/repo/output.txt",
      completionReason: "worker-reparented",
    },
    completedTimestampMs: BigInt(43),
  })

  assert.deepEqual(updated, {
    parentToolCallId: "call-1",
    environment: "cloud",
    status: "backgrounded",
    title: "existing title",
    detail: "existing detail",
    transcriptPath: "/repo/transcript.jsonl",
    outputPath: "/repo/output.txt",
    completedTimestampMs: BigInt(43),
    completionReason: "worker-reparented",
  })
})

test("a blank first completion still leaves a bounded, explicit run record", () => {
  const updated = updateSlateSubagentRun({
    completion: completion({
      status: "unknown",
      title: "",
      subagentId: " ",
      taskId: " ",
    }),
    parentToolCallId: "call-1",
    completedTimestampMs: BigInt(44),
  })

  assert.deepEqual(updated, {
    parentToolCallId: "call-1",
    environment: "unspecified",
    status: "unspecified",
    completedTimestampMs: BigInt(44),
  })
})

test("an unknown persisted enum survives progress and retires on explicit Slate updates", () => {
  const existingRun = {
    parentToolCallId: "call-1",
    environment: "unspecified" as const,
    status: "unspecified" as const,
    compatibility: {
      legacyEnvironmentCode: 41,
      legacyStatusCode: 42,
      legacyCompletionReasonCode: 43,
    },
  }
  const progress = updateSlateSubagentRun({
    completion: completion({ status: "unknown", reason: undefined }),
    parentToolCallId: "call-1",
    environment: "unspecified",
    existingRun,
    completedTimestampMs: 45n,
  })
  assert.deepEqual(progress.compatibility, existingRun.compatibility)

  const updated = updateSlateSubagentRun({
    completion: completion({ status: "success", reason: "task-progress" }),
    parentToolCallId: "call-1",
    environment: "cloud",
    existingRun,
    completedTimestampMs: 46n,
  })
  assert.equal(updated.compatibility, undefined)
  assert.equal(updated.status, "success")
  assert.equal(updated.environment, "cloud")
  assert.equal(updated.completionReason, "task-progress")
})

test("unknown completion enum codes carry into durable run migration metadata", () => {
  const updated = updateSlateSubagentRun({
    completion: completion({
      status: "unknown",
      reason: undefined,
      compatibility: { legacyStatusCode: 52, legacyReasonCode: 57 },
    }),
    parentToolCallId: "call-1",
    completedTimestampMs: 47n,
  })

  assert.equal(updated.status, "unspecified")
  assert.deepEqual(updated.compatibility, {
    legacyStatusCode: 52,
    legacyCompletionReasonCode: 57,
  })
})
