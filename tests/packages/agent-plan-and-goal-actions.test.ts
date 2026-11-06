import { test } from "node:test"
import assert from "node:assert/strict"

import {
  resolvePlanFilePath,
  sanitizePlanFileName,
} from "../../source/packages/agent/actions/execute-plan-plan-file.ts"
import { collectPlanTodoDrafts } from "../../source/packages/agent/actions/execute-plan-frontmatter.ts"
import {
  createPlanExecutionMessage,
  decodeExecutePlanAction,
  toRedactedPlanTodos,
} from "../../source/adapters/interop/agent/execute-plan-action-adapter.ts"
import { slateModeForPlanExecutionMode } from "../../source/packages/agent/actions/execute-plan-contracts.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"
import { GoalContinuationActionHandler } from "../../source/packages/agent/actions/goal-continuation-action-handler.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { conversationIdKey } from "../../source/packages/agent/utils/request-scope.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { SYSTEM_NOTIFICATION_TAG } from "../../source/packages/constants/system-notification.ts"
import {
  SlateGoalState,
  type SlateGoalState as SlateGoalStateType,
} from "../../source/packages/agent/goal-state.ts"
import { SlateGoalStatus } from "../../source/packages/agent-core/goal-continuation.ts"
import { AgentMode, SimulatedMsgReason } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { TodoStatus } from "../../source/adapters/interop/proto/generated/agent/v1/todo_tool_pb.ts"

test("a plan action projects its mode vocabulary into Slate's conversation modes", () => {
  assert.equal(slateModeForPlanExecutionMode("agent"), SlateMode.AGENT)
  assert.equal(slateModeForPlanExecutionMode("chat"), SlateMode.CHAT)
  assert.equal(slateModeForPlanExecutionMode("multitask"), SlateMode.MULTITASK)
  assert.equal(slateModeForPlanExecutionMode("unspecified"), SlateMode.UNSPECIFIED)
})

// ---------------------------------------------------------------------------------------------
// where a plan's file is
// ---------------------------------------------------------------------------------------------

type ReadAnswer = { result: { case: string } }
type WriteAnswer = { result: { case: string } }

function planResources(options: {
  read?: ReadAnswer | (() => never)
  write?: WriteAnswer | (() => never)
} = {}): {
  readonly reads: Array<{ path: string; limit?: number }>
  readonly writes: Array<{ path: string; fileText?: string }>
  readonly io: {
    exists(context: Context, path: string): Promise<boolean>
    restoreFile(context: Context, path: string, content: string): Promise<boolean>
  }
} {
  const reads: Array<{ path: string; limit?: number }> = []
  const writes: Array<{ path: string; fileText?: string }> = []
  const io = {
    async exists(_context: Context, path: string) {
      reads.push({ path, limit: 1 })
      const answer = options.read
      if (typeof answer === "function") return answer()
      return (answer ?? { result: { case: "fileNotFound" } }).result.case === "success"
    },
    async restoreFile(_context: Context, path: string, content: string) {
      writes.push({ path, fileText: content })
      const answer = options.write
      if (typeof answer === "function") return answer()
      return (answer ?? { result: { case: "success" } }).result.case === "success"
    },
  }
  return { reads, writes, io }
}

test("a filename taken from a path is reduced to a safe last segment", () => {
  assert.equal(sanitizePlanFileName("some/folder/plan.md"), "plan.md")
  assert.equal(sanitizePlanFileName("some\\folder\\plan.md"), "plan.md")
  assert.equal(sanitizePlanFileName("a plan: with spaces.md"), "a_plan__with_spaces.md")
  assert.equal(sanitizePlanFileName(""), undefined)
  assert.equal(sanitizePlanFileName("folder/"), undefined)
  assert.equal(sanitizePlanFileName("."), undefined)
  assert.equal(sanitizePlanFileName(".."), undefined)
})

test("with nowhere to write a plan, the path the turn was given is all there is", async () => {
  const resources = planResources()
  const resolution = await resolvePlanFilePath(createContext(), {}, resources.io, { path: "/tmp/plan.md" }, "content")
  assert.deepEqual(resolution, {
    planFilePath: "/tmp/plan.md",
    recreatedPlanFilePath: undefined,
    shouldUpsertPlanRegistryEntry: false,
    availability: "unknown",
  })
  assert.deepEqual(resources.reads, [])
})

test("a plan file that is where it was is used as it is", async () => {
  const resources = planResources({ read: { result: { case: "success" } } })
  const resolution = await resolvePlanFilePath(
    createContext(),
    { env: { artifactsFolder: "/repo/artifacts" } },
    resources.io,
    { path: "/repo/plan.md" },
    "the plan",
  )
  assert.equal(resolution.availability, "on_disk")
  assert.equal(resolution.planFilePath, "/repo/plan.md")
  assert.equal(resolution.shouldUpsertPlanRegistryEntry, true)
  // The probe reads one line, because the plan itself is already in memory.
  assert.deepEqual(resources.reads, [{ path: "/repo/plan.md", limit: 1 }])
  assert.deepEqual(resources.writes, [])
})

test("a plan file that is gone is written again under its own name", async () => {
  const resources = planResources()
  const resolution = await resolvePlanFilePath(
    createContext(),
    { env: { artifactsFolder: "/repo/artifacts" } },
    resources.io,
    { path: "/somewhere/old/plan.md" },
    "the plan text",
  )
  assert.equal(resolution.availability, "on_disk")
  assert.equal(resolution.planFilePath, "/repo/artifacts/plans/plan.md")
  assert.equal(resolution.recreatedPlanFilePath, "/repo/artifacts/plans/plan.md")
  assert.deepEqual(resources.writes, [{ path: "/repo/artifacts/plans/plan.md", fileText: "the plan text" }])
})

test("a plan file that is gone and unnamed is written again under the plan's identifier", async () => {
  const resources = planResources()
  const resolution = await resolvePlanFilePath(
    createContext(),
    { env: { artifactsFolder: "/repo/artifacts" } },
    resources.io,
    { id: "plan-42" },
    "the plan text",
  )
  assert.equal(resolution.recreatedPlanFilePath, "/repo/artifacts/plans/plan-42.plan.md")
})

test("a plan with neither a path nor an identifier is written again as plan.md", async () => {
  const resources = planResources()
  const resolution = await resolvePlanFilePath(
    createContext(),
    { env: { artifactsFolder: "/repo/artifacts" } },
    resources.io,
    {},
    "the plan text",
  )
  assert.equal(resolution.recreatedPlanFilePath, "/repo/artifacts/plans/plan.md")
})

test("the path is built the way the session's platform builds paths", async () => {
  const resources = planResources()
  const resolution = await resolvePlanFilePath(
    createContext(),
    { env: { artifactsFolder: "C:\\repo\\artifacts", osVersion: "Windows win32" } },
    resources.io,
    {},
    "the plan text",
  )
  assert.equal(resolution.recreatedPlanFilePath, "C:\\repo\\artifacts\\plans\\plan.md")
})

test("a plan that cannot be written again is not registered", async () => {
  const resources = planResources({ write: { result: { case: "error" } } })
  const resolution = await resolvePlanFilePath(
    createContext(),
    { env: { artifactsFolder: "/repo/artifacts" } },
    resources.io,
    { path: "/somewhere/old/plan.md" },
    "the plan text",
  )
  assert.deepEqual(resolution, {
    planFilePath: "/somewhere/old/plan.md",
    recreatedPlanFilePath: undefined,
    shouldUpsertPlanRegistryEntry: false,
    availability: "unavailable",
  })
})

test("a plan whose resolution threw is reported as unavailable rather than as resolved", async () => {
  const resources = planResources({ read: () => { throw new Error("the workspace is gone") } })
  const resolution = await resolvePlanFilePath(
    createContext(),
    { env: { artifactsFolder: "/repo/artifacts" } },
    resources.io,
    { path: "/repo/plan.md" },
    "the plan text",
  )
  assert.equal(resolution.availability, "unavailable")
  assert.equal(resolution.planFilePath, "/repo/plan.md")
  assert.equal(resolution.shouldUpsertPlanRegistryEntry, false)
})

test("plan todos can be listed directly or grouped into phases", () => {
  assert.deepEqual(
    collectPlanTodoDrafts('---\nphases:\n  - todos:\n      - id: "phase-1"\n        content: "first task"\n        status: in_progress\n        dependencies: ["setup"]\n  - todos:\n      - id: "phase-2"\n        content: "second task"\n---\nplan body'),
    [
      { id: "phase-1", content: "first task", status: "in_progress", dependencies: ["setup"] },
      { id: "phase-2", content: "second task", status: undefined, dependencies: [] },
    ],
  )
  assert.deepEqual(
    collectPlanTodoDrafts('---\ntodos:\n  - id: "task-1"\n    content: "top-level task"\n---\nplan body'),
    [{ id: "task-1", content: "top-level task", status: undefined, dependencies: [] }],
  )
})

test("plan frontmatter without actionable todos yields no drafts", () => {
  assert.deepEqual(collectPlanTodoDrafts("# plan without todo metadata"), [])
  assert.deepEqual(collectPlanTodoDrafts("---\nphases: invalid: [\n---\nplan body"), [])
})

test("the plan boundary turns omitted and explicit modes into host-owned choices", () => {
  const missingMode = decodeExecutePlanAction({})
  const redacted = (value: string) => ({ unwrap: () => value })
  const askMode = decodeExecutePlanAction({
    executionMode: AgentMode.ASK,
    planFileContent: redacted("# Plan"),
    planFilePath: redacted("/workspace/plan.md"),
    planFileUri: redacted("cursor-plan://plan.md"),
    planId: "plan-42",
    kickoffMessageId: "kickoff-1",
  })

  assert.equal(missingMode.mode, "agent")
  assert.equal(askMode.mode, "chat")
  assert.equal(askMode.schema, "slate.agent-action.execute-plan")
  assert.equal(askMode.planText, "# Plan")
  assert.equal(askMode.path, "/workspace/plan.md")
  assert.equal(askMode.sourceUri, "cursor-plan://plan.md")
  assert.equal(askMode.id, "plan-42")
  assert.equal(askMode.messageId, "kickoff-1")
})

test("a plan becomes a simulated turn with its content and context attached", () => {
  const { userMessage, slateUserMessage, listenerUpdate } = createPlanExecutionMessage({
    text: "Implement the plan",
    messageId: "kickoff-1",
    planContent: "# Plan\n\nFirst step",
    planPath: "/workspace/plan.md",
    planTitle: "Plan",
    executionMode: "chat",
    rootProject: true,
    planId: "plan-42",
    listenerPrivacyMode: PrivacyMode.NO_STORAGE,
  })

  assert.equal(userMessage.mode, AgentMode.ASK)
  assert.equal(userMessage.isSimulatedMsg, true)
  assert.equal(userMessage.executePlanInfo?.planId, "plan-42")
  assert.deepEqual(slateUserMessage.planExecution, { id: "plan-42", title: "Plan" })
  assert.equal(userMessage.selectedContext?.codeSelections[0]?.path, "/workspace/plan.md")
  assert.equal(userMessage.selectedContext?.codeSelections[0]?.range?.end?.line, 3)
  assert.ok(listenerUpdate)
})

test("plan todo conversion keeps known statuses and defaults unknown statuses", () => {
  const todos = toRedactedPlanTodos([
    { id: "done", content: "finished", status: "completed", dependencies: [] },
    { id: "new", content: "not started", status: "unexpected", dependencies: [] },
  ], PrivacyMode.NO_STORAGE) as Array<{ status?: number }>

  assert.deepEqual(todos.map(todo => todo.status), [TodoStatus.COMPLETED, TodoStatus.PENDING])
})

// ---------------------------------------------------------------------------------------------
// keeping a goal moving
// ---------------------------------------------------------------------------------------------



type GoalShape = SlateGoalStateType

function goalState(overrides: Partial<GoalShape> = {}): GoalShape {
  return new SlateGoalState({
    // A goal is only this conversation's to continue when its id and owner are both well-formed.
    goalId: "0123abcd-4567-89ef-0123-456789abcdef",
    objective: "make the tests pass",
    status: SlateGoalStatus.ACTIVE,
    continuationCount: 0,
    idleContinuationsWithoutToolCalls: 0,
    conversationId: "conversation-1",
    agentSessionId: "session-1",
    ...overrides,
  })
}

interface StateHarness {
  readonly setGoalStateCalls: GoalShape[]
  readonly updates: number
  readonly stateHandler: {
    goalState: GoalShape | undefined
    mode: SlateMode
    setGoalState(next: GoalShape): void
    computeNewStructure(ctx: Context): Promise<{ turns: unknown[] }>
    getPrivacyMode(): PrivacyMode
    getBlobStore(): undefined
  }
}

function stateHarness(initial: GoalShape | undefined, mode: SlateMode = SlateMode.AGENT): StateHarness {
  let current = initial
  const setGoalStateCalls: GoalShape[] = []
  const harness: StateHarness = {
    setGoalStateCalls,
    updates: 0,
    stateHandler: {
      get goalState() { return current },
      mode,
      setGoalState(next) { current = next; setGoalStateCalls.push(next) },
      async computeNewStructure() { return { turns: [] } },
      getPrivacyMode: () => PrivacyMode.NO_STORAGE,
      getBlobStore: () => undefined,
    },
  }
  return harness
}

const toolsGenerator = () => ({
  getTool: (identifier: string) => identifier === "TODO_WRITE" ? { name: "TodoWrite" } : { name: "UpdateGoal" },
})

function handlerWith(userMessageActionHandler: unknown, state: StateHarness): GoalContinuationActionHandler {
  return new GoalContinuationActionHandler(userMessageActionHandler, toolsGenerator, {}, "session-1")
}

const ctxWithConversation = (): Context => createContext().with(conversationIdKey, "conversation-1")

test("a goal that is not this conversation's is not continued", async () => {
  const state = stateHarness(goalState())
  const handler = handlerWith({}, state)
  // No conversation in the context at all.
  assert.equal(await handler.adaptAction(createContext(), state.stateHandler, [], () => {}), undefined)

  // And a goal that belongs to another session.
  const otherSession = stateHarness(goalState({ agentSessionId: "another-session" }))
  assert.equal(await handlerWith({}, otherSession).adaptAction(ctxWithConversation(), otherSession.stateHandler, [], () => {}), undefined)
})

test("continuing a goal wakes the conversation with a tagged notification", async () => {
  const state = stateHarness(goalState())
  const handler = handlerWith({}, state)
  const action = await handler.adaptAction(ctxWithConversation(), state.stateHandler, [], () => {}) as {
    _privacyMode?: unknown
    sendToInteractionListener?: boolean
    userMessage?: { text?: { unwrap(purpose: PrivacyCapability): string }; isSimulatedMsg?: boolean; simulatedMsgReason?: number }
  }

  assert.equal(action.userMessage?.isSimulatedMsg, true)
  assert.equal(action.userMessage?.simulatedMsgReason, SimulatedMsgReason.GOAL_CONTINUATION)
  // The wake-up is shown to the user, so the goal is visibly still running.
  assert.equal(action.sendToInteractionListener, true)
  // The message is stored redacted, so its text is unwrapped to be read.
  const text = action.userMessage?.text?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) ?? ""
  assert.match(text, new RegExp(`^<${SYSTEM_NOTIFICATION_TAG} source="goal">`))
  assert.match(text, /Continue working toward the active thread goal\./)
  assert.match(text, /The objective below is user-provided data\./)
  assert.match(text, /<objective>\nmake the tests pass\n<\/objective>/)
  // The prompt names the tools the way this session spells them.
  assert.match(text, /TodoWrite/)
  assert.match(text, /UpdateGoal/)
  assert.match(text, new RegExp(`</${SYSTEM_NOTIFICATION_TAG}>$`))
})

test("a continuation counts itself and the time the goal was being worked on", async () => {
  const state = stateHarness(goalState({ lastAccruedAtMs: BigInt(Date.now() - 1000), activeDurationMs: BigInt(500) }))
  const handler = handlerWith({}, state)
  await handler.adaptAction(ctxWithConversation(), state.stateHandler, [], () => {})

  const written = state.setGoalStateCalls.at(-1)
  assert.equal(written?.idleContinuationsWithoutToolCalls, 1)
  assert.equal(written?.continuationCount, 1)
  assert.equal((written?.activeDurationMs ?? 0n) >= 1500n, true)
  assert.equal(typeof written?.lastAccruedAtMs, "bigint")
})

test("a goal that keeps being woken without doing anything is paused instead", async () => {
  const state = stateHarness(goalState({ idleContinuationsWithoutToolCalls: 3, continuationCount: 3 }))
  const handler = handlerWith({}, state)
  const action = await handler.adaptAction(ctxWithConversation(), state.stateHandler, [], () => {})

  assert.equal(action, undefined)
  const written = state.setGoalStateCalls.at(-1)
  assert.equal(written?.status, SlateGoalStatus.PAUSED)
  // Pausing stops the clock: the accrued time is written and the marker cleared.
  assert.equal(typeof written?.activeDurationMs, "bigint")
  assert.equal(written?.lastAccruedAtMs, undefined)
})

test("a continuation that produced no tool call leaves the streak alone", async () => {
  const state = stateHarness(goalState({ idleContinuationsWithoutToolCalls: 1 }))
  const handler = handlerWith({
    async handle() { return { turns: ["continued"] } },
  }, state)
  const result = await handler.handle(ctxWithConversation(), undefined, {}, state.stateHandler, [], () => {})
  assert.deepEqual(result, { turns: ["continued"] })
  // Nothing was cleared: the only goal state written is the continuation itself.
  assert.equal(state.setGoalStateCalls.every(call => call.idleContinuationsWithoutToolCalls === 2), true)
})

test("a continuation that used a tool clears the streak", async () => {
  const state = stateHarness(goalState({ idleContinuationsWithoutToolCalls: 2 }))
  const handler = handlerWith({
    async handle(_ctx: Context, _action: unknown, executor: { executeToolStream(...args: unknown[]): unknown }) {
      // A tool call recorded through the wrapped executor is what the streak is waiting for.
      await executor.executeToolStream({}, {}, {}, {}, {}, async () => {}, {}, {})
      return { turns: ["worked"] }
    },
  }, state)
  const result = await handler.handle(ctxWithConversation(), undefined, {
    executeToolStream: async (_ctx: unknown, _state: unknown, _handler: unknown, _tools: unknown, _extra: unknown, record: (ctx: unknown, result: unknown, name: unknown, classification: unknown) => Promise<void>) => {
      await record({}, { ok: true }, "Read", undefined)
    },
  }, state.stateHandler, [], () => {})

  assert.deepEqual(result, { turns: [] })
  // The streak was cleared, so the last goal state written has no idle continuations.
  assert.equal(state.setGoalStateCalls.at(-1)?.idleContinuationsWithoutToolCalls, 0)
})

test("clearing a streak that is already clear writes nothing", async () => {
  const state = stateHarness(goalState({ idleContinuationsWithoutToolCalls: 0 }))
  const handler = handlerWith({}, state)
  assert.equal(await handler.clearIdleContinuationStreak(ctxWithConversation(), state.stateHandler, () => {}), undefined)
  assert.deepEqual(state.setGoalStateCalls, [])
})

test("a goal that is not continued leaves each entry point with its own empty answer", async () => {
  const state = stateHarness(goalState({ agentSessionId: "another-session" }))
  const handler = handlerWith({}, state)

  assert.deepEqual(
    await handler.handleSingleStep(ctxWithConversation(), undefined, {}, state.stateHandler, [], () => {}),
    { state: { turns: [] }, hasToolCall: false },
  )
  assert.deepEqual(
    await handler.handleModelStep(ctxWithConversation(), undefined, {}, state.stateHandler, [], () => {}),
    {
      state: { turns: [] },
      toolCallDescriptors: [],
      splitStepData: { modelResponseMessages: [], goalContinuationNoop: true },
    },
  )
  assert.deepEqual(
    await handler.handle(ctxWithConversation(), undefined, {}, state.stateHandler, [], () => {}),
    { turns: [] },
  )
})

test("a single-step continuation that used a tool also clears the streak", async () => {
  const state = stateHarness(goalState({ idleContinuationsWithoutToolCalls: 1 }))
  const handler = handlerWith({
    async handleSingleStep() { return { state: { turns: ["stepped"] }, hasToolCall: true } },
  }, state)
  const result = await handler.handleSingleStep(ctxWithConversation(), undefined, {}, state.stateHandler, [], () => {})
  assert.deepEqual(result, { state: { turns: [] }, hasToolCall: true })
  assert.equal(state.setGoalStateCalls.at(-1)?.idleContinuationsWithoutToolCalls, 0)
})

test("a single-step continuation with no tool call is left as it is", async () => {
  const state = stateHarness(goalState({ idleContinuationsWithoutToolCalls: 1 }))
  const handler = handlerWith({
    async handleSingleStep() { return { state: { turns: ["idle"] }, hasToolCall: false } },
  }, state)
  const result = await handler.handleSingleStep(ctxWithConversation(), undefined, {}, state.stateHandler, [], () => {})
  assert.deepEqual(result, { state: { turns: ["idle"] }, hasToolCall: false })
})

test("a model-step continuation with no tool call is left as it is", async () => {
  const state = stateHarness(goalState({ idleContinuationsWithoutToolCalls: 1 }))
  const handler = handlerWith({
    async handleModelStep() { return { state: { turns: ["idle"] }, toolCallDescriptors: [], splitStepData: {} } },
  }, state)
  const result = await handler.handleModelStep(ctxWithConversation(), undefined, {}, state.stateHandler, [], () => {})
  assert.deepEqual(result, { state: { turns: ["idle"] }, toolCallDescriptors: [], splitStepData: {} })
})

test("the handler exposes the user message handler it was given", () => {
  const inner = { marker: "the user message handler" }
  const handler = new GoalContinuationActionHandler(inner, toolsGenerator, {}, "session-1")
  assert.equal(handler.getUserMessageActionHandler(), inner)
})
