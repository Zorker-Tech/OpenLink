import { test } from "node:test"
import assert from "node:assert/strict"

import {
  fromInteropConversationState,
  toInteropConversationState,
} from "../../source/adapters/interop/agent/agent-state-message-serdes-adapter.ts"
import { fromRedactedConversationStateStructureInterop } from "../../source/adapters/interop/agent/agent-state-message-serdes-adapter.ts"
import {
  fromRedactedConversationStateStructure,
  toRedactedConversationStateStructure,
} from "../../source/adapters/interop/redacted-protos/generated/agent/v1/agent_redacted.ts"
import {
  AgentMode,
  ConversationStateStructure,
  FileStateStructure,
  GoalState,
  PlanRegistryEntry,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { GoalStatus } from "../../source/adapters/interop/proto/generated/agent/v1/goal_tool_pb.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"
import { SlateGoalState } from "../../source/packages/agent/goal-state.ts"
import { SlateGoalStatus } from "../../source/packages/agent-core/goal-continuation.ts"
import { DataClassification, PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import type { SlateRedactedValue } from "../../source/packages/agent/conversation-state.ts"
import { RedactedString } from "../../source/packages/redaction/redacted-values.ts"

test("conversation state projects its persisted mode and fields into Slate", () => {
  const source = new ConversationStateStructure({
    turns: [new Uint8Array([1]), new Uint8Array([2])],
    rootPromptMessagesJson: [new Uint8Array([3])],
    mode: AgentMode.PLAN,
    activeBranchName: "feature",
    conversationStartedTimestampMs: BigInt(10),
  })
  const redacted = toRedactedConversationStateStructure(source, PrivacyMode.NO_STORAGE)
  const slate = fromInteropConversationState(redacted)

  assert.equal(slate.mode, SlateMode.PLAN)
  assert.equal(slate.privacyMode, PrivacyMode.NO_STORAGE)
  assert.deepEqual(slate.turns, source.turns)
  assert.deepEqual(slate.rootPromptMessagesJson, source.rootPromptMessagesJson)
  assert.equal(slate.activeBranchName, "feature")
  assert.equal(slate.conversationStartedTimestampMs, BigInt(10))

  const roundTripped = toInteropConversationState(slate)
  assert.equal(roundTripped.mode, AgentMode.PLAN)
  assert.equal(roundTripped._privacyMode, PrivacyMode.NO_STORAGE)
})

test("an unknown conversation mode uses Slate's fallback without losing its source code", () => {
  const redacted = toRedactedConversationStateStructure(
    new ConversationStateStructure({ mode: 987654 as AgentMode }),
    PrivacyMode.NO_STORAGE,
  )
  const slate = fromInteropConversationState(redacted)
  const roundTripped = toInteropConversationState(slate)

  assert.equal(slate.mode, SlateMode.UNSPECIFIED)
  assert.equal(slate.unknownModeCode, 987654)
  assert.equal(roundTripped.mode, 987654)
})

test("file state paths and blob references become plain Slate values", () => {
  const redacted = toRedactedConversationStateStructure(
    new ConversationStateStructure({
      fileStatesV2: {
        "/repo/a.ts": new FileStateStructure({
          content: new Uint8Array([1]),
          initialContent: new Uint8Array([2]),
        }),
      },
    }),
    PrivacyMode.NO_STORAGE,
  )
  const slate = fromInteropConversationState(redacted)

  assert.deepEqual(slate.fileStatesV2.get("/repo/a.ts"), {
    contentBlobId: new Uint8Array([1]),
    initialContentBlobId: new Uint8Array([2]),
  })

  const plain = fromRedactedConversationStateStructure(
    toInteropConversationState(slate),
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  )
  const restored = Object.values(plain.fileStatesV2)[0] as FileStateStructure | undefined
  assert.deepEqual(restored?.content, new Uint8Array([1]))
  assert.deepEqual(restored?.initialContent, new Uint8Array([2]))
})

test("read paths are plain Slate values in memory and privacy-wrapped only in checkpoints", () => {
  const exactPath = "/repo/ spaced.ts "
  const redacted = toRedactedConversationStateStructure(
    new ConversationStateStructure({
      readPaths: ["/repo/a.ts", "/repo/b.ts", exactPath],
    }),
    PrivacyMode.NO_STORAGE,
  )
  const slate = fromInteropConversationState(redacted)

  assert.deepEqual(slate.readPaths, ["/repo/a.ts", "/repo/b.ts", exactPath])

  const interop = toInteropConversationState(slate)
  const firstReadPath = interop.readPaths[0]
  assert.ok(firstReadPath instanceof RedactedString)
  assert.equal(firstReadPath.__classification, DataClassification.PATH)
  assert.equal(firstReadPath.__fieldName, "read_paths")
  assert.equal(firstReadPath.__privacyMode, PrivacyMode.NO_STORAGE)
  assert.deepEqual(
    interop.readPaths.map(
      (path: SlateRedactedValue<string>) =>
        path.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
    ),
    ["/repo/a.ts", "/repo/b.ts", exactPath],
  )
  const plain = fromRedactedConversationStateStructure(
    interop,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  )
  assert.deepEqual(plain.readPaths, ["/repo/a.ts", "/repo/b.ts", exactPath])
})

test("plan registry and goal state use Slate types and retain an unknown status code", () => {
  const unknownStatus = 4_096 as GoalStatus
  const redacted = toRedactedConversationStateStructure(
    new ConversationStateStructure({
      plans: {
        "plan-1": new PlanRegistryEntry({ id: "plan-1", path: "/repo/plan.md" }),
      },
      goalState: new GoalState({
        conversationId: "conversation-1",
        goalId: "goal-1",
        objective: "ship the first version",
        status: unknownStatus,
        continuationCount: 2,
      }),
    }),
    PrivacyMode.NO_STORAGE,
  )
  const slate = fromInteropConversationState(redacted)

  assert.deepEqual(slate.plans?.get("plan-1"), { id: "plan-1", path: "/repo/plan.md" })
  assert.ok(slate.goalState instanceof SlateGoalState)
  assert.equal(slate.goalState.status, SlateGoalStatus.UNSPECIFIED)
  assert.equal(slate.goalState.unknownStatusCode, unknownStatus)

  const restored = fromRedactedConversationStateStructureInterop(
    toInteropConversationState(slate),
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  )
  assert.equal(Object.values(restored.plans)[0]?.path, "/repo/plan.md")
  assert.equal(restored.goalState?.status, unknownStatus)
})
