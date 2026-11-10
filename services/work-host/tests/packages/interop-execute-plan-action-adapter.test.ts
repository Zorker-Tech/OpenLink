import { test } from "node:test"
import assert from "node:assert/strict"

import { AgentMode, SimulatedMsgReason } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { TodoStatus } from "../../source/adapters/interop/proto/generated/agent/v1/todo_tool_pb.ts"
import { createRedactedString } from "../../source/packages/redaction/create.ts"
import { DataClassification } from "../../source/packages/redaction/classification.ts"
import { RedactedString } from "../../source/packages/redaction/redacted-values.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"
import { readExecutorResource } from "../../source/packages/agent-exec/read-operation.ts"
import { writeExecutorResource } from "../../source/packages/agent-exec/write-operation.ts"
import {
  createExecutePlanPlanFileIO,
  createPlanExecutionMessage,
  createPlanRegistryEntry,
  decodeExecutePlanAction,
  isInteropPlanTodoComplete,
  toInteropAgentMode,
  toRedactedPlanTodos,
} from "../../source/adapters/interop/agent/execute-plan-action-adapter.ts"
import {
  planDocumentUri,
  unavailablePlanDocumentUri,
} from "../../source/adapters/interop/agent/plan-file-uri-adapter.ts"

test("legacy plan document URIs are formed only at the interop boundary", () => {
  assert.equal(planDocumentUri("agent-1", "plan.plan.md"), "slate-plan://agent-1/plan.plan.md")
  assert.equal(planDocumentUri(undefined, "plan.plan.md"), "slate-plan:///plan.plan.md")
  assert.equal(unavailablePlanDocumentUri(), "slate-plan://plan.md")
})

test("the action boundary decodes plan fields and maps known modes into host modes", () => {
  const planFileContent = createRedactedString("# Plan", DataClassification.CODE, "plan", PrivacyMode.UNSPECIFIED)
  const planFilePath = createRedactedString("/repo/plan.md", DataClassification.PATH, "path", PrivacyMode.UNSPECIFIED)
  const planFileUri = createRedactedString("plan://source", DataClassification.PATH, "path", PrivacyMode.UNSPECIFIED)
  const requestContext = { env: { timeZone: "UTC" } }
  const decoded = decodeExecutePlanAction({
    planFileContent,
    planFilePath,
    planFileUri,
    planId: "plan-1",
    kickoffMessageId: "message-1",
    executionMode: AgentMode.ASK,
    requestContext,
    _privacyMode: PrivacyMode.NO_STORAGE,
  })

  assert.equal(decoded.planText, "# Plan")
  assert.equal(decoded.path, "/repo/plan.md")
  assert.equal(decoded.sourceUri, "plan://source")
  assert.equal(decoded.id, "plan-1")
  assert.equal(decoded.messageId, "message-1")
  assert.equal(decoded.schema, "slate.agent-action.execute-plan")
  assert.equal(decoded.mode, "chat")
  assert.equal(decoded.privacyMode, PrivacyMode.NO_STORAGE)
  assert.equal(decoded.compatibility?.requestContext, requestContext)
  assert.ok(decoded.compatibility?.legacyPayload)
  assert.equal(toInteropAgentMode("chat"), AgentMode.ASK)
  assert.equal(decodeExecutePlanAction({ executionMode: AgentMode.UNSPECIFIED }).mode, "agent")
  const unknownMode = decodeExecutePlanAction({ executionMode: 987654 })
  assert.equal(unknownMode.mode, "unspecified")
  assert.equal(toInteropAgentMode(unknownMode.mode), AgentMode.UNSPECIFIED)
})

test("the plan message carries its source selection and a matching redacted update", () => {
  const result = createPlanExecutionMessage({
    text: "Begin the plan",
    messageId: "plan-kickoff",
    planContent: "# Plan\n\nStep",
    planPath: "/repo/plan.md",
    planTitle: "Plan",
    executionMode: "multitask",
    rootProject: true,
    planId: "plan-1",
    listenerPrivacyMode: PrivacyMode.UNSPECIFIED,
  })

  assert.equal(result.userMessage.text, "Begin the plan")
  assert.equal(result.userMessage.messageId, "plan-kickoff")
  assert.equal(result.userMessage.mode, AgentMode.MULTITASK)
  assert.equal(result.userMessage.isSimulatedMsg, true)
  assert.equal(result.userMessage.simulatedMsgReason, SimulatedMsgReason.PLAN_EXECUTION)
  assert.equal(result.userMessage.executePlanInfo?.planId, "plan-1")
  assert.equal(result.userMessage.executePlanInfo?.planTitle, "Plan")
  assert.equal(result.userMessage.projectDetails !== undefined, true)
  const selection = result.userMessage.selectedContext?.codeSelections[0]
  assert.equal(selection?.path, "/repo/plan.md")
  assert.equal(selection?.content, "# Plan\n\nStep")
  assert.equal(selection?.range?.start?.line, 1)
  assert.equal(selection?.range?.end?.line, 3)
  assert.equal(result.listenerUpdate.kind, "user-message-appended")
  assert.equal(result.listenerUpdate.privacyMode, PrivacyMode.UNSPECIFIED)
  assert.equal(result.listenerUpdate.message.text instanceof RedactedString, true)
})

test("a future plan mode is policy-safe and round-trips through the stored user message", () => {
  const result = createPlanExecutionMessage({
    text: "Continue with the plan",
    messageId: "kickoff-unknown-mode",
    planContent: "# Plan",
    planPath: "/repo/plan.md",
    planTitle: "Plan",
    executionMode: "unspecified",
    rootProject: false,
    planId: "plan-1",
    listenerPrivacyMode: PrivacyMode.NO_STORAGE,
  })
  assert.equal(result.userMessage.mode, AgentMode.UNSPECIFIED)
  assert.equal(result.slateUserMessage.mode, SlateMode.UNSPECIFIED)
})

test("plan todos cross the boundary as redacted entries and unknown statuses default to pending", () => {
  const todos = toRedactedPlanTodos([
    { id: "one", content: "First", status: "in_progress", dependencies: ["setup"] },
    { id: "two", content: "Second", status: "unknown", dependencies: [] },
  ], PrivacyMode.UNSPECIFIED) as Array<{ status: number; content: string }>

  assert.equal(todos.length, 2)
  assert.equal(todos[0]?.status, TodoStatus.IN_PROGRESS)
  assert.equal(todos[1]?.status, TodoStatus.PENDING)
  assert.equal(isInteropPlanTodoComplete(TodoStatus.COMPLETED), true)
  assert.equal(isInteropPlanTodoComplete(TodoStatus.IN_PROGRESS), false)
  const entry = createPlanRegistryEntry("plan-1", "/repo/plan.md")
  assert.equal(entry.id, "plan-1")
  assert.equal(entry.path, "/repo/plan.md")
})

test("the plan file adapter translates its narrow port into read and write executor messages", async () => {
  const sent: Array<{ readonly kind: string; readonly args: { readonly path?: string; readonly limit?: number; readonly text?: string; readonly includeContentAfterWrite?: boolean } }> = []
  const resourceAccessor = {
    get(resource: unknown) {
      const kind = resource === readExecutorResource ? "read" : resource === writeExecutorResource ? "write" : "unknown"
      return {
        execute: async (_context: unknown, args: never) => {
          const request = args as Record<string, unknown>
          sent.push({
            kind,
            args: {
              ...(typeof request.path === "string" ? { path: request.path } : {}),
              ...(typeof request.limit === "number" ? { limit: request.limit } : {}),
              ...(typeof request.text === "string" ? { text: request.text } : {}),
              ...(typeof request.includeContentAfterWrite === "boolean"
                ? { includeContentAfterWrite: request.includeContentAfterWrite }
                : {}),
            },
          })
          return kind === "read"
            ? { kind: "success", path: String(request.path ?? ""), totalLines: 0, fileSize: 0n, truncated: false, rangeApplied: false }
            : { kind: "success", path: String(request.path ?? ""), linesWritten: 0, bytesWritten: 0 }
        },
      }
    },
  }
  const fileIO = createExecutePlanPlanFileIO(resourceAccessor)

  assert.equal(await fileIO.exists(undefined as never, "/repo/plan.md"), true)
  assert.equal(await fileIO.restoreFile(undefined as never, "/repo/artifacts/plan.md", "plan"), true)
  assert.deepEqual(sent, [
    { kind: "read", args: { path: "/repo/plan.md", limit: 1 } },
    { kind: "write", args: { path: "/repo/artifacts/plan.md", text: "plan", includeContentAfterWrite: false } },
  ])
})
