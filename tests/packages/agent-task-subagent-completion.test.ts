import { test } from "node:test"
import assert from "node:assert/strict"

import {
  buildFollowupAction,
  executeSubagentStopHook,
  handleSubagentExecutionError,
  handleSubagentRunStreamError,
  processSubagentIterationSuccess,
  type TaskHookContext,
  type TaskSubagentCompletionContext,
  type TaskSubagentCompletionDependencies,
  type TaskSubagentIterationState,
} from "../../source/packages/agent/tools/task-subagent-completion.ts"
import type { ConversationAction, TaskResult } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import type { ConversationBlobStore } from "../../source/packages/agent/tools/task-runtime.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { generateSeededUuid } from "../../source/packages/agent/tools/tool-support.ts"
import { SelectedContext } from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import {
  AgentMode,
  ConversationStateStructure,
  ConversationStep,
  ConversationTurnStructure,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import {
  SubagentType,
  SubagentTypeUnspecified,
} from "../../source/adapters/interop/proto/generated/agent/v1/subagents_pb.ts"
import type { ExecuteHookArgs } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts"

// ---------------------------------------------------------------------------------------------
// a hook executor that answers the way a workspace would
// ---------------------------------------------------------------------------------------------

interface HookCall {
  readonly step: string
  readonly request: Record<string, unknown>
}

function hookHarness(answer: (call: HookCall) => unknown | Promise<unknown>): {
  readonly calls: HookCall[]
  readonly executor: { execute(ctx: Context, args: ExecuteHookArgs): Promise<unknown> }
} {
  const calls: HookCall[] = []
  return {
    calls,
    executor: {
      async execute(_ctx, args) {
        const request = args.request?.request
        const step = request?.case ?? "unknown"
        const call = { step, request: (request?.value ?? {}) as Record<string, unknown> }
        calls.push(call)
        return await answer(call)
      },
    },
  }
}

function stopHookAnswer(followupMessage?: string): unknown {
  return { response: { response: { case: "subagentStop", value: followupMessage === undefined ? {} : { followupMessage } } } }
}

function hookContext(overrides: Record<string, unknown> = {}): TaskHookContext {
  return {
    ctx: createContext(),
    subagentId: "subagent-1",
    subagentType: new SubagentType({ type: { case: "unspecified", value: new SubagentTypeUnspecified({}) } }),
    toolCallId: "call-1",
    overriddenModelId: "composer-2",
    ...overrides,
  }
}

function hookOptions(harness: { executor: { execute(ctx: Context, args: ExecuteHookArgs): Promise<unknown> } }): Record<string, unknown> {
  return {
    resourceAccessor: { get: () => harness.executor },
    enableExecuteHookExec: true,
    configuredSteps: ["subagentStop", "postToolUse"],
  }
}

const baseStopArgs = {
  status: "completed" as const,
  durationMs: 120,
  messageCount: 3,
  toolCallCount: 2,
  loopCount: 0,
  task: "do the thing",
  description: "the thing",
}

function taskResultOf(value: unknown): TaskResult | undefined {
  return value as TaskResult | undefined
}

function conversationActionOf(value: unknown): ConversationAction | undefined {
  return value as ConversationAction | undefined
}

// ---------------------------------------------------------------------------------------------
// the subagent's own stop hook
// ---------------------------------------------------------------------------------------------

test("a completed subagent's stop hook may answer with something to do next", async () => {
  const harness = hookHarness(() => stopHookAnswer("  keep going  "))
  const followup = await executeSubagentStopHook({ ...hookContext(), ...hookOptions(harness), ...baseStopArgs })
  assert.equal(followup, "keep going")
  assert.equal(harness.calls.length, 1)
  assert.equal(harness.calls[0]?.step, "subagentStop")
  assert.equal(harness.calls[0]?.request.status, "completed")
  assert.equal(harness.calls[0]?.request.task, "do the thing")
  assert.equal(harness.calls[0]?.request.description, "the thing")
  assert.equal(harness.calls[0]?.request.toolCallCount, 2)
  assert.equal(harness.calls[0]?.request.model, "composer-2")
})

test("a hook that answers nothing leaves the subagent finished", async () => {
  const harness = hookHarness(() => stopHookAnswer())
  assert.equal(await executeSubagentStopHook({ ...hookContext(), ...hookOptions(harness), ...baseStopArgs }), undefined)
})

test("a failed subagent is never given a follow-up, whatever the hook answers", async () => {
  const harness = hookHarness(() => stopHookAnswer("try again"))
  const followup = await executeSubagentStopHook({
    ...hookContext(),
    ...hookOptions(harness),
    ...baseStopArgs,
    status: "error",
    errorMessage: "the run failed",
  })
  assert.equal(followup, undefined)
  assert.equal(harness.calls[0]?.request.status, "error")
  assert.equal(harness.calls[0]?.request.errorMessage, "the run failed")
})

test("a hook that cannot run does not make a finished subagent look unfinished", async () => {
  const failing = hookHarness(() => { throw new Error("hook executor is gone") })
  assert.equal(await executeSubagentStopHook({ ...hookContext(), ...hookOptions(failing), ...baseStopArgs }), undefined)

  // And a session with no hooks configured at all is not an error either.
  assert.equal(await executeSubagentStopHook({ ...hookContext(), ...baseStopArgs }), undefined)
})

test("a follow-up is a message to the subagent, with an id that does not change between retries", () => {
  const action = conversationActionOf(buildFollowupAction({ followupMessage: "keep going", toolCallId: "call-1", loopCount: 2, useAskMode: false }))!
  assert.equal(action.action.case, "userMessageAction")
  const message = action.action.case === "userMessageAction" ? action.action.value.userMessage : undefined
  assert.equal(message?.text, "keep going")
  assert.equal(message?.mode, AgentMode.AGENT)

  const again = conversationActionOf(buildFollowupAction({ followupMessage: "keep going", toolCallId: "call-1", loopCount: 2, useAskMode: false }))!
  assert.equal(again.action.case === "userMessageAction" ? again.action.value.userMessage?.messageId : "", message?.messageId)

  const askMode = conversationActionOf(buildFollowupAction({ followupMessage: "keep going", toolCallId: "call-1", loopCount: 3, useAskMode: true }))!
  assert.equal(askMode.action.case === "userMessageAction" ? askMode.action.value.userMessage?.mode : undefined, AgentMode.ASK)
  assert.notEqual(askMode.action.case === "userMessageAction" ? askMode.action.value.userMessage?.messageId : "", message?.messageId)
})

// ---------------------------------------------------------------------------------------------
// a subagent's turn came back
// ---------------------------------------------------------------------------------------------

const idOf = (n: number): Uint8Array => new Uint8Array([n])

function blobStoreOf(entries: Array<{ id: Uint8Array; bytes: Uint8Array }>): ConversationBlobStore {
  const byKey = new Map(entries.map(entry => [Buffer.from(entry.id).toString("hex"), entry.bytes]))
  return {
    async getBlob(_ctx: Context, blobId: Uint8Array) {
      return byKey.get(Buffer.from(blobId).toString("hex"))
    },
  }
}

function conversationWith(text: string, toolCalls: number): {
  readonly state: ConversationStateStructure
  readonly blobStore: ConversationBlobStore
} {
  const stepIds = [10, 11, 12]
  const entries = [
    { id: idOf(1), bytes: new ConversationTurnStructure({ turn: { case: "agentConversationTurn", value: { steps: stepIds.map(idOf) } as never } }).toBinary() },
    { id: idOf(10), bytes: new ConversationStep({ message: { case: "assistantMessage", value: { text } } as never }).toBinary() },
    ...Array.from({ length: toolCalls }, (_value, index) => ({
      id: idOf(11 + index),
      bytes: new ConversationStep({ message: { case: "toolCall", value: {} } as never }).toBinary(),
    })),
  ]
  return { state: new ConversationStateStructure({ turns: [idOf(1)] }), blobStore: blobStoreOf(entries) }
}

const completionCtx: TaskSubagentCompletionContext = {
  subagentId: "subagent-1",
  subagentRequestId: "request-1",
  toolCallId: "call-1",
  typeName: "generalPurpose",
  analyticsSubagentType: "generalPurpose",
  overriddenModelId: "composer-2",
  effectiveReadonly: false,
  useAskModeForSubagent: false,
  initialTurnsCount: 0,
  executionStartTime: Date.now() - 250,
  isParallel: false,
  parentModelName: "composer-2",
  rawArgsPrompt: "do the thing",
  rawArgsDescription: "the thing",
}

function dependencies(harness: { executor: { execute(ctx: Context, args: ExecuteHookArgs): Promise<unknown> } }, blobStore: ConversationBlobStore, overrides: Partial<TaskSubagentCompletionDependencies> = {}): {
  readonly deps: TaskSubagentCompletionDependencies
  readonly cleaned: string[]
} {
  const cleaned: string[] = []
  return {
    cleaned,
    deps: {
      ctx: createContext(),
      blobStore,
      registry: { cleanup: (subagentId: string) => { cleaned.push(subagentId) } },
      hookContext: hookContext(hookOptions(harness)),
      enableTaskToolHooksExec: true,
      configuredSteps: ["subagentStop", "postToolUse"],
      toolName: "Task",
      postToolUseHookInput: { prompt: "do the thing" },
      ...overrides,
    },
  }
}

const iterationState = (): TaskSubagentIterationState => ({ loopCount: 0, runStreamCompleted: false, subagentStopCalled: false })

test("a subagent that finishes without a follow-up produces its result and is dropped from the registry", async () => {
  const harness = hookHarness(call => call.step === "subagentStop" ? stopHookAnswer() : { response: { response: { case: "postToolUse", value: {} } } })
  const { state, blobStore } = conversationWith("the answer", 2)
  const { deps, cleaned } = dependencies(harness, blobStore)
  const persisted: Array<{ subagentId: string; state: { readonly modelId: string } }> = []
  const iterState = iterationState()

  const result = await processSubagentIterationSuccess(
    state,
    0,
    iterState,
    completionCtx,
    deps,
    (_ctx, subagentId, _type, persistedState) => {
      persisted.push({ subagentId, state: persistedState as { readonly modelId: string } })
    },
    new SubagentType({ type: { case: "unspecified", value: new SubagentTypeUnspecified({}) } }),
  )

  assert.equal(iterState.subagentStopCalled, true)
  assert.deepEqual(persisted.map(entry => entry.subagentId), ["subagent-1"])
  assert.equal(persisted[0]?.state.modelId, "composer-2")
  assert.equal(result.shouldContinue, false)
  const finalResult = taskResultOf(result.finalResult)
  assert.equal(finalResult?.result.case, "success")
  if (finalResult?.result.case !== "success") return
  assert.equal(finalResult.result.value.agentId, "subagent-1")
  assert.equal(finalResult.result.value.conversationSteps.length, 3)
  assert.equal(typeof finalResult.result.value.durationMs, "bigint")
  assert.deepEqual(cleaned, ["subagent-1"])
  // The stop hook saw the summary and the counts; the post-tool-use hook saw the outcome.
  assert.equal(harness.calls.filter(call => call.step === "subagentStop").length, 1)
  assert.equal(harness.calls.find(call => call.step === "subagentStop")?.request.summary, "the answer")
  assert.equal(harness.calls.find(call => call.step === "subagentStop")?.request.messageCount, 1)
  assert.equal(harness.calls.find(call => call.step === "subagentStop")?.request.toolCallCount, 2)
  const postToolUse = harness.calls.find(call => call.step === "postToolUse")
  assert.equal(JSON.parse(String(postToolUse?.request.toolOutput)).status, "success")
  assert.equal(JSON.parse(String(postToolUse?.request.toolOutput)).toolCallCount, 2)
})

test("a subagent that is asked to keep going continues instead of finishing", async () => {
  const harness = hookHarness(() => stopHookAnswer("check the tests too"))
  const { state, blobStore } = conversationWith("the answer", 0)
  const { deps, cleaned } = dependencies(harness, blobStore)
  const iterState = iterationState()

  const result = await processSubagentIterationSuccess(
    state,
    0,
    iterState,
    completionCtx,
    deps,
    () => {},
    new SubagentType({ type: { case: "unspecified", value: new SubagentTypeUnspecified({}) } }),
  )

  assert.equal(result.shouldContinue, true)
  assert.equal(result.finalResult, undefined)
  assert.equal(iterState.loopCount, 1)
  const nextAction = conversationActionOf(result.nextAction)
  const message = nextAction?.action.case === "userMessageAction" ? nextAction.action.value.userMessage : undefined
  assert.equal(message?.text, "check the tests too")
  assert.equal(message?.mode, AgentMode.AGENT)
  // The subagent is still running, so nothing has been cleaned up and no result has been built.
  assert.deepEqual(cleaned, [])
  assert.equal(harness.calls.some(call => call.step === "postToolUse"), false)
})

test("only the turns since the last iteration are counted", async () => {
  const harness = hookHarness(call => call.step === "subagentStop" ? stopHookAnswer() : { response: { response: { case: "postToolUse", value: {} } } })
  const { state, blobStore } = conversationWith("the answer", 1)
  // Two turns already existed before this iteration, so only this one's blobs are read.
  const stateWithHistory = new ConversationStateStructure({ turns: [idOf(7), idOf(8), ...state.turns] })
  const { deps } = dependencies(harness, blobStore)
  const result = await processSubagentIterationSuccess(
    stateWithHistory,
    2,
    iterationState(),
    completionCtx,
    deps,
    () => {},
    new SubagentType({ type: { case: "unspecified", value: new SubagentTypeUnspecified({}) } }),
  )
  const finalResult = taskResultOf(result.finalResult)
  if (finalResult?.result.case !== "success") throw new Error("expected a result")
  assert.equal(finalResult.result.value.conversationSteps.length, 2)
  assert.equal(harness.calls.find(call => call.step === "subagentStop")?.request.messageCount, 3)
})

test("a post-tool-use hook that fails does not turn a finished subagent into a failed one", async () => {
  const harness = hookHarness(call => {
    if (call.step === "postToolUse") throw new Error("hook executor is gone")
    return stopHookAnswer()
  })
  const { state, blobStore } = conversationWith("the answer", 0)
  const { deps, cleaned } = dependencies(harness, blobStore)
  const result = await processSubagentIterationSuccess(state, 0, iterationState(), completionCtx, deps, () => {}, new SubagentType({}))
  assert.equal(taskResultOf(result.finalResult)?.result.case, "success")
  assert.deepEqual(cleaned, ["subagent-1"])
})

test("the post-tool-use hook runs only where the tool allows hooks to run", async () => {
  const harness = hookHarness(call => call.step === "subagentStop" ? stopHookAnswer() : { response: { response: { case: "postToolUse", value: {} } } })
  const { state, blobStore } = conversationWith("the answer", 0)
  const { deps } = dependencies(harness, blobStore, { enableTaskToolHooksExec: false })
  const result = await processSubagentIterationSuccess(state, 0, iterationState(), completionCtx, deps, () => {}, new SubagentType({}))
  assert.equal(taskResultOf(result.finalResult)?.result.case, "success")
  // The subagent's own stop hook still runs: it is the only place a subagent ending can be observed.
  assert.deepEqual(harness.calls.map(call => call.step), ["subagentStop"])
})

test("a result suffix is carried into the result only when the type asked for one", async () => {
  const harness = hookHarness(() => stopHookAnswer())
  const { state, blobStore } = conversationWith("the answer", 0)
  const { deps } = dependencies(harness, blobStore, { enableTaskToolHooksExec: false })

  const plain = await processSubagentIterationSuccess(state, 0, iterationState(), completionCtx, deps, () => {}, new SubagentType({}))
  const plainResult = taskResultOf(plain.finalResult)
  assert.equal(plainResult?.result.case === "success" ? plainResult.result.value.resultSuffix : "unset", undefined)

  const suffixed = await processSubagentIterationSuccess(
    state,
    0,
    iterationState(),
    { ...completionCtx, resultSuffix: "\n\nDone." },
    deps,
    () => {},
    new SubagentType({}),
  )
  const suffixedResult = taskResultOf(suffixed.finalResult)
  assert.equal(suffixedResult?.result.case === "success" ? suffixedResult.result.value.resultSuffix : "", "\n\nDone.")
})

// ---------------------------------------------------------------------------------------------
// a subagent that did not finish
// ---------------------------------------------------------------------------------------------

test("a failed run stream is reported to the hook and then passed on unchanged", async () => {
  const harness = hookHarness(() => stopHookAnswer())
  const { state, blobStore } = conversationWith("partial answer", 1)
  const { deps } = dependencies(harness, blobStore)
  const iterState = iterationState()
  const failure = new Error("the stream broke")

  await assert.rejects(
    () => handleSubagentRunStreamError(failure, state, iterState, completionCtx, deps, false, undefined),
    (error: unknown) => error === failure,
  )
  assert.equal(iterState.subagentStopCalled, true)
  assert.equal(harness.calls[0]?.request.status, "error")
  assert.equal(harness.calls[0]?.request.errorMessage, "the stream broke")
  assert.equal(harness.calls[0]?.request.toolCallCount, 0)
})

test("a failure that is not an error is still reported as text", async () => {
  const harness = hookHarness(() => stopHookAnswer())
  const { state, blobStore } = conversationWith("partial answer", 0)
  const { deps } = dependencies(harness, blobStore)
  await assert.rejects(
    () => handleSubagentRunStreamError("something odd", state, iterationState(), completionCtx, deps, false, undefined),
    (error: unknown) => error === "something odd",
  )
  assert.equal(harness.calls[0]?.request.errorMessage, "something odd")
})

test("an execution failure drops the subagent and reports it only when there is a state to report", async () => {
  const harness = hookHarness(() => stopHookAnswer())
  const { state, blobStore } = conversationWith("partial answer", 0)
  const { deps, cleaned } = dependencies(harness, blobStore)
  const failure = new Error("the subagent could not start")

  await assert.rejects(
    () => handleSubagentExecutionError(failure, state, iterationState(), completionCtx, deps, false, undefined),
    (error: unknown) => error === failure,
  )
  assert.deepEqual(cleaned, ["subagent-1"])
  assert.equal(harness.calls[0]?.request.status, "error")
  assert.equal(harness.calls[0]?.request.errorMessage, "the subagent could not start")

  const withoutState = hookHarness(() => stopHookAnswer())
  const second = dependencies(withoutState, blobStore)
  await assert.rejects(
    () => handleSubagentExecutionError(failure, undefined, iterationState(), completionCtx, second.deps, false, undefined),
    (error: unknown) => error === failure,
  )
  assert.deepEqual(second.cleaned, ["subagent-1"])
  assert.deepEqual(withoutState.calls, [])
})

// ---------------------------------------------------------------------------------------------
// the pieces this rewrite split out
// ---------------------------------------------------------------------------------------------

test("a follow-up message id is seeded from the call and the turn, so retries agree", () => {
  const expected = generateSeededUuid("call-1-followup-2")
  const action = conversationActionOf(buildFollowupAction({ followupMessage: "keep going", toolCallId: "call-1", loopCount: 2, useAskMode: false }))!
  const message = action.action.case === "userMessageAction" ? action.action.value.userMessage : undefined
  assert.equal(message?.messageId, expected)

  const withoutContext = conversationActionOf(buildFollowupAction({ followupMessage: "keep going", toolCallId: "call-1", loopCount: 2, useAskMode: false }))!
  const withoutMessage = withoutContext.action.case === "userMessageAction" ? withoutContext.action.value.userMessage : undefined
  assert.equal(withoutMessage?.selectedContext, undefined, "a follow-up without a context carries none")
})

test("a subagent that is asked to keep going in ask mode produces an ask-mode follow-up", async () => {
  const harness = hookHarness(() => stopHookAnswer("ask this"))
  const { state, blobStore } = conversationWith("the answer", 0)
  const { deps } = dependencies(harness, blobStore, { enableTaskToolHooksExec: false })
  const iterState = iterationState()
  const result = await processSubagentIterationSuccess(
    state,
    0,
    iterState,
    { ...completionCtx, useAskModeForSubagent: true },
    deps,
    () => {},
    new SubagentType({}),
  )
  const nextAction = conversationActionOf(result.nextAction)
  const message = nextAction?.action.case === "userMessageAction" ? nextAction.action.value.userMessage : undefined
  assert.equal(message?.mode, AgentMode.ASK)
  assert.equal(iterState.loopCount, 1)
})

test("an empty follow-up answer finishes the subagent instead of continuing it", async () => {
  const harness = hookHarness(() => stopHookAnswer(""))
  const { state, blobStore } = conversationWith("the answer", 0)
  const { deps } = dependencies(harness, blobStore, { enableTaskToolHooksExec: false })
  const iterState = iterationState()
  const result = await processSubagentIterationSuccess(state, 0, iterState, completionCtx, deps, () => {}, new SubagentType({}))
  assert.equal(result.shouldContinue, false)
  assert.equal(iterState.loopCount, 0)
})

test("the duration a finished subagent reports is measured from when it was started", async () => {
  const harness = hookHarness(() => stopHookAnswer())
  const { state, blobStore } = conversationWith("the answer", 0)
  const { deps } = dependencies(harness, blobStore, { enableTaskToolHooksExec: false })
  const startedAt = completionCtx.executionStartTime
  const before = Date.now()
  const result = await processSubagentIterationSuccess(state, 0, iterationState(), completionCtx, deps, () => {}, new SubagentType({}))
  const after = Date.now()
  const final = taskResultOf(result.finalResult)
  if (final?.result.case !== "success") throw new Error("expected a success")
  const duration = final.result.value.durationMs ?? 0n
  assert.equal(duration >= BigInt(before - startedAt), true, "at least the time before the call has passed")
  assert.equal(duration <= BigInt(after - startedAt), true, "and not more than the time after it")
})


test("a hook that answers something other than a string does not continue the subagent", async () => {
  const harness = hookHarness(() => ({ response: { response: { case: "subagentStop", value: { followupMessage: 42 } } } }))
  const { state, blobStore } = conversationWith("the answer", 0)
  const { deps } = dependencies(harness, blobStore, { enableTaskToolHooksExec: false })
  const iterState = iterationState()
  const result = await processSubagentIterationSuccess(state, 0, iterState, completionCtx, deps, () => {}, new SubagentType({}))
  assert.equal(result.shouldContinue, false)
  assert.equal(iterState.loopCount, 0)
})

test("a follow-up carries the selected context it was given", () => {
  const context = new SelectedContext({})
  const action = conversationActionOf(buildFollowupAction({ followupMessage: "keep going", toolCallId: "call-1", loopCount: 2, useAskMode: false, selectedContext: context }))!
  const message = action.action.case === "userMessageAction" ? action.action.value.userMessage : undefined
  assert.notEqual(message?.selectedContext, undefined, "the context it was given is carried")
})

test("only the turns of this iteration are collected into the result", async () => {
  const harness = hookHarness(() => stopHookAnswer())
  // Three turns with blobs: two older ones and the turn this iteration added.
  const turnBlob = (stepIds: number[]): Uint8Array => new ConversationTurnStructure({ turn: { case: "agentConversationTurn", value: { steps: stepIds.map(idOf) } as never } }).toBinary()
  const entries = [
    { id: idOf(7), bytes: turnBlob([20]) },
    { id: idOf(8), bytes: turnBlob([21]) },
    { id: idOf(1), bytes: turnBlob([10]) },
    { id: idOf(10), bytes: new ConversationStep({ message: { case: "assistantMessage", value: { text: "new" } } as never }).toBinary() },
    { id: idOf(20), bytes: new ConversationStep({ message: { case: "assistantMessage", value: { text: "old one" } } as never }).toBinary() },
    { id: idOf(21), bytes: new ConversationStep({ message: { case: "assistantMessage", value: { text: "old two" } } as never }).toBinary() },
  ]
  const { deps } = dependencies(harness, blobStoreOf(entries), { enableTaskToolHooksExec: false })
  const state = new ConversationStateStructure({ turns: [idOf(7), idOf(8), idOf(1)] })
  const result = await processSubagentIterationSuccess(state, 2, iterationState(), { ...completionCtx, initialTurnsCount: 2 }, deps, () => {}, new SubagentType({}))
  const finalResult = taskResultOf(result.finalResult)
  if (finalResult?.result.case !== "success") throw new Error("expected a success")
  assert.equal(finalResult.result.value.conversationSteps.length, 1, "the older turns are not collected")
})
