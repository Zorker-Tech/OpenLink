import { test } from "node:test"
import assert from "node:assert/strict"

import {
  BackgroundTaskCompletionReason,
  SubagentExecutionEnvironment,
  SubagentRunState,
  SubagentRunStatus,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import {
  fromInteropSubagentRunState,
  slateSubagentEnvironmentFromInterop,
  toInteropSubagentRunState,
} from "../../source/adapters/interop/agent/subagent-run-state-adapter.ts"

test("all persisted run states project into Slate's complete lifecycle vocabulary", () => {
  const cases = [
    [SubagentRunStatus.UNSPECIFIED, "unspecified"],
    [SubagentRunStatus.RUNNING, "running"],
    [SubagentRunStatus.BACKGROUNDED, "backgrounded"],
    [SubagentRunStatus.SUCCESS, "success"],
    [SubagentRunStatus.ERROR, "error"],
    [SubagentRunStatus.ABORTED, "aborted"],
  ] as const

  for (const [wire, slate] of cases) {
    const result = fromInteropSubagentRunState(new SubagentRunState({
      parentToolCallId: "call-1",
      status: wire,
    }))
    assert.equal(result.status, slate)
  }
})

test("a run record round-trips every field through the external storage schema", () => {
  const wire = new SubagentRunState({
    parentToolCallId: "call-1",
    subagentId: "agent-1",
    environment: SubagentExecutionEnvironment.CLOUD,
    status: SubagentRunStatus.BACKGROUNDED,
    title: "research",
    detail: "waiting for the worker",
    transcriptPath: "/repo/transcript.jsonl",
    outputPath: "/repo/output.txt",
    completedTimestampMs: BigInt(45),
    completionReason: BackgroundTaskCompletionReason.WORKER_REPARENTED,
  })

  const slate = fromInteropSubagentRunState(wire)
  assert.deepEqual(slate, {
    parentToolCallId: "call-1",
    subagentId: "agent-1",
    environment: "cloud",
    status: "backgrounded",
    title: "research",
    detail: "waiting for the worker",
    transcriptPath: "/repo/transcript.jsonl",
    outputPath: "/repo/output.txt",
    completedTimestampMs: BigInt(45),
    completionReason: "worker-reparented",
  })

  assert.deepEqual(toInteropSubagentRunState(slate), wire)
})

test("unknown environment values fail closed while unspecified stays absent for updates", () => {
  assert.equal(slateSubagentEnvironmentFromInterop(999 as SubagentExecutionEnvironment), undefined)
  assert.equal(slateSubagentEnvironmentFromInterop(SubagentExecutionEnvironment.UNSPECIFIED), undefined)
  assert.equal(slateSubagentEnvironmentFromInterop(SubagentExecutionEnvironment.LOCAL), "local")
  assert.equal(slateSubagentEnvironmentFromInterop(SubagentExecutionEnvironment.CLOUD), "cloud")
})

test("unknown run enum values map to unspecified", () => {
  const wire = new SubagentRunState({
    parentToolCallId: "call-unknown",
    environment: 4_097 as SubagentExecutionEnvironment,
    status: 4_098 as SubagentRunStatus,
    completionReason: 4_099 as BackgroundTaskCompletionReason,
  })
  const slate = fromInteropSubagentRunState(wire)

  assert.equal(slate.environment, "unspecified")
  assert.equal(slate.status, "unspecified")
  const restored = toInteropSubagentRunState(slate)
  assert.equal(restored.environment, SubagentExecutionEnvironment.UNSPECIFIED)
  assert.equal(restored.status, SubagentRunStatus.UNSPECIFIED)
  assert.equal(restored.completionReason, undefined)
})
