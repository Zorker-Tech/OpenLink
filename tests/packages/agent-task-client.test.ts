import { test } from "node:test"
import assert from "node:assert/strict"

import {
  buildClientContinuationConfig,
  executeClientSideTaskSubagent,
  formatSubagentBackgroundMessage,
  maybeAppendInterruptRetryHint,
  renderClientTaskResult,
  renderTaskResultToString,
  serializeError,
  type ClientTaskExecutionArgs,
  type ClientTaskStateHandler,
} from "../../source/packages/agent/tools/task-client.ts"
import type { TaskSubagentResolution } from "../../source/packages/agent/tools/task-subagent-preparation.ts"
import type { SlateTaskRequest } from "../../source/packages/agent/tools/task-runtime-types.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { conversationIdKey, conversationGroupIdKey } from "../../source/packages/agent/utils/request-scope.ts"
import { DataClassification } from "../../source/packages/redaction/classification.ts"
import { createRedactedString } from "../../source/packages/redaction/create.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { slateSubagentExecutorResource } from "../../source/packages/agent-exec/subagent.ts"
import type { SubagentContinuationConfig, SubagentExecutionArgs, SubagentExecutionResult } from "../../source/packages/agent-exec/subagent.ts"
import { RUNNING_SUBAGENT_FOLLOWUP_ERROR, RUNNING_SUBAGENT_INTERRUPT_RETRY_HINT } from "../../source/packages/agent-exec/subagent.ts"
import { slateSubagentBackgroundHandoffExecutorResource } from "../../source/packages/agent-exec/subagent-control.ts"
import { WriteIterableClosedError } from "../../source/packages/utils/writable-iterable.ts"
import {
  TaskResult,
  ToolCall,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { createSlateSubagentType, SlateSubagentKind } from "../../source/packages/agent/subagent-type.ts"
import type { SlateSubagentPersistedState } from "../../source/packages/agent/subagent-persisted-state.ts"
import {
  createSlateTaskAssistantStep,
  createSlateTaskErrorResult,
  createSlateTaskSuccessResult,
  createSlateTaskSummaryStep,
  projectSlateTaskResult,
  SlateTaskBackgroundReason,
  type SlateTaskResult,
} from "../../source/packages/agent/tools/task-result-state.ts"
import {
  createSlateConversationSummaryToolCall,
  createSlateToolCallStep,
  type SlateConversationStep,
} from "../../source/packages/agent/conversation-step-state.ts"
import {
  fromInteropTaskResultInterop,
  toInteropTaskResultInterop,
} from "../../source/adapters/interop/agent/task-tool-protocol-adapter.ts"

// ---------------------------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------------------------

const GENERAL_PURPOSE = createSlateSubagentType(SlateSubagentKind.GENERAL_PURPOSE)
const COORDINATOR = createSlateSubagentType(SlateSubagentKind.CUSTOM, { customName: "coordinator-agent" })

const answerStep = (text: string): SlateConversationStep => createSlateTaskAssistantStep(text)

const summaryStep = (finalSummary: string): SlateConversationStep => createSlateTaskSummaryStep(finalSummary)

const successResult = (fields: {
  conversationSteps?: SlateConversationStep[]
  backgroundReason?: SlateTaskBackgroundReason
  transcriptUri?: string
  agentId?: string
  resultSuffix?: string
} = {}): SlateTaskResult => createSlateTaskSuccessResult({
  conversationSteps: fields.conversationSteps ?? [],
  durationMs: 12n,
  isBackground: (fields.backgroundReason ?? SlateTaskBackgroundReason.UNSPECIFIED) !== SlateTaskBackgroundReason.UNSPECIFIED,
  backgroundReason: fields.backgroundReason ?? SlateTaskBackgroundReason.UNSPECIFIED,
  ...(fields.transcriptUri === undefined ? {} : { transcriptUri: fields.transcriptUri }),
  ...(fields.agentId === undefined ? {} : { agentId: fields.agentId }),
  ...(fields.resultSuffix === undefined ? {} : { resultSuffix: fields.resultSuffix }),
})

const errorResult = (error: string) => createSlateTaskErrorResult(error)

function resolution(overrides: Record<string, unknown> = {}): TaskSubagentResolution {
  return {
    subagentConfig: { subagentType: GENERAL_PURPOSE, isBackground: false },
    effectiveReadonly: false,
    useAskModeForSubagent: false,
    typeName: "generalPurpose",
    analyticsSubagentType: "generalPurpose",
    resolvedModelId: "model-1",
    subagentId: "subagent-1",
    isResume: false,
    subagentRequestId: "request-1",
    isSelfForkRequested: false,
    effectiveEnvironment: "local",
    effectiveTargetMachine: { kind: "same-device" },
    ...overrides,
  } as unknown as TaskSubagentResolution
}

const rawArgs = (overrides: Partial<SlateTaskRequest> = {}): SlateTaskRequest => ({ prompt: "do the thing", ...overrides })

interface Executed {
  readonly args: SubagentExecutionArgs
  readonly ctx: Context
}

/** A run that answers: the executor records the request it was handed and returns the result asked for. */
function executionHarness(options: {
  result?: SubagentExecutionResult
  fail?: Error
  forceBackgroundStatus?: "accepted" | "not-found"
} = {}) {
  const executed: Executed[] = []
  const handoffs: string[] = []
  const persisted: Array<{ subagentId: string; state: SlateSubagentPersistedState }> = []
  const injections: Array<() => void> = []
  const subagentExecutor = {
    async execute(ctx: Context, args: SubagentExecutionArgs) {
      executed.push({ args, ctx })
      if (options.fail !== undefined) throw options.fail
      return options.result ?? {
        status: "success",
        agentId: "agent-1",
        finalMessage: "the answer",
        toolCallCount: 0,
      }
    },
  }
  const forceBackgroundExecutor = {
    async execute(_ctx: Context, args: { toolCallId: string }) {
      handoffs.push(args.toolCallId)
      return { status: options.forceBackgroundStatus ?? "accepted" }
    },
  }
  const accessor = {
    get: (resource: unknown) => resource === slateSubagentExecutorResource
      ? subagentExecutor
      : resource === slateSubagentBackgroundHandoffExecutorResource ? forceBackgroundExecutor : undefined,
  }
  const stateHandler: ClientTaskStateHandler = {
    turns: [],
    getPrivacyMode: () => PrivacyMode.NO_STORAGE,
    persistSubagentState(_ctx, subagentId, _type, state) { persisted.push({ subagentId, state }) },
  }
  const signal = {
    pending: false,
    hasPendingUserInjections: () => signal.pending,
    onUserInjectionAdmitted(listener: () => void) { injections.push(listener); return () => { injections.splice(injections.indexOf(listener), 1) } },
  }
  const run = async (args: {
    ctx?: Context
    raw?: Partial<SlateTaskRequest>
    resolved?: Record<string, unknown>
    signal?: boolean
  } = {}) => await executeClientSideTaskSubagent({
    ctx: args.ctx ?? createContext(),
    toolCallId: "call-1",
    rawArgs: rawArgs(args.raw),
    resolved: resolution(args.resolved),
    resourceAccessor: accessor as never,
    stateHandler,
    parentModelName: "parent-model",
    ...(args.signal === true ? { contextInjectionSignal: signal } : {}),
  } as ClientTaskExecutionArgs)
  return { run, executed, handoffs, persisted, signal, injections, stateHandler }
}

test("a background run sends the background flag to the executor", async () => {
  const harnessed = executionHarness()
  await harnessed.run({ raw: { runInBackground: true } })
  assert.equal(harnessed.executed[0]?.args.runInBackground, true)
})

// ---------------------------------------------------------------------------------------------
// what a finished run reads as
// ---------------------------------------------------------------------------------------------

test("a finished subagent reads as its answer, tagged so the platform can find it", () => {
  assert.equal(
    renderTaskResultToString(successResult({ conversationSteps: [answerStep("the answer")] })),
    "This is the output of the subagent:\n\nresponse:\n<response>\nthe answer\n</response>",
  )
})

test("an answer that already carries its own response tags is not tagged again", () => {
  const answer = "response:\n<response>\nalready tagged\n</response>"
  const rendered = renderTaskResultToString(successResult({ conversationSteps: [answerStep(answer)] }))
  assert.equal(rendered, `This is the output of the subagent:\n\nresponse:\n${answer}`)
  assert.equal(rendered.match(/<response>/g)?.length, 1)
})

test("the subagent's own summary is shown above its answer", () => {
  const rendered = renderTaskResultToString(successResult({ conversationSteps: [answerStep("the answer"), summaryStep("the summary")] }))
  assert.match(rendered, /<user_visible_high_level_summary>\nthe summary\n<\/user_visible_high_level_summary>/)
  assert.match(rendered, /<response>\nthe answer\n<\/response>/)
})

test("task result projection does not reveal a redacted summary string", () => {
  const redactedSummary = createSlateToolCallStep({
    tool: createSlateConversationSummaryToolCall({
      source: "final",
      args: {
        finalSummary: createRedactedString(
          "private summary",
          DataClassification.CODE,
          "final_summary",
          PrivacyMode.NO_STORAGE,
        ),
      },
    }),
  })
  const result = successResult({ conversationSteps: [summaryStep("prior summary"), redactedSummary] })
  const view = projectSlateTaskResult(result)

  assert.equal(view.kind, "success")
  if (view.kind === "success") assert.equal(view.chosenSummary, "prior summary")
})

test("a run hidden from notifications shows only its answer", () => {
  const rendered = renderTaskResultToString(
    successResult({ conversationSteps: [answerStep("the answer"), summaryStep("the summary")] }),
    { hideAsyncSubagentTaskNotifications: true },
  )
  assert.equal(rendered.includes("the summary"), false)
  assert.match(rendered, /<response>\nthe answer\n<\/response>/)
})

test("a run that said nothing is reported as having said nothing", () => {
  assert.match(renderTaskResultToString(successResult()), /<response>\nNo output\n<\/response>/)
})

test("a background run reads as a note that it is still going", () => {
  const rendered = renderTaskResultToString(successResult({
    backgroundReason: SlateTaskBackgroundReason.AGENT_REQUEST,
    transcriptUri: "/tmp/transcript.jsonl",
  }))
  assert.match(rendered, /^Subagent is running in the background\./)
  assert.match(rendered, /tailing the transcript at: \/tmp\/transcript\.jsonl/)
  assert.equal(rendered.includes("<response>"), false)
})

test("with completion notifications the note says the answer arrives on its own", () => {
  const rendered = renderTaskResultToString(
    successResult({ backgroundReason: SlateTaskBackgroundReason.AGENT_REQUEST, transcriptUri: "/tmp/transcript.jsonl" }),
    { enableJobCompletionNotifications: true },
  )
  assert.match(rendered, /you will be automatically sent the subagent's final response/)
  assert.match(rendered, /Do NOT mention the transcript path to the user/)
})

test("a background run without a transcript is told only that it is running", () => {
  assert.equal(
    formatSubagentBackgroundMessage(SlateTaskBackgroundReason.AGENT_REQUEST, "   "),
    "Subagent is running in the background.",
  )
  assert.equal(
    formatSubagentBackgroundMessage(SlateTaskBackgroundReason.USER_REQUEST, undefined),
    "The user manually backgrounded the subagent. It is still running; you can continue with other work.",
  )
  assert.equal(
    formatSubagentBackgroundMessage(SlateTaskBackgroundReason.QUEUED_FOLLOW_UP, undefined),
    RUNNING_SUBAGENT_FOLLOWUP_ERROR,
  )
})

test("the agent id is handed over with what it can be used for", () => {
  const withLinks = renderTaskResultToString(successResult({ conversationSteps: [answerStep("done")], agentId: "agent-7" }))
  assert.match(withLinks, /Agent ID: agent-7/)
  assert.match(withLinks, /`resume` parameter/)
  assert.match(withLinks, /\[label\]\(agent-7\)/)
  const withoutLinks = renderTaskResultToString(
    successResult({ conversationSteps: [answerStep("done")], agentId: "agent-7" }),
    { enableAgentChatLinks: false },
  )
  assert.equal(withoutLinks.includes("[label](agent-7)"), false)
})

test("a suffix the platform added is shown after the answer", () => {
  const rendered = renderTaskResultToString(successResult({ conversationSteps: [answerStep("done")], resultSuffix: "the box was reclaimed" }))
  assert.match(rendered, /the box was reclaimed$/)
})

test("Slate task results preserve conversation content and unknown background codes at the runner boundary", () => {
  const source = createSlateTaskSuccessResult({
    conversationSteps: [answerStep("answer"), summaryStep("summary")],
    agentId: "agent-8",
    isBackground: true,
    durationMs: 22n,
    resultSuffix: "done",
    backgroundReason: "unknown-4096",
    transcriptUri: "/tmp/transcript.jsonl",
  })
  const restored = fromInteropTaskResultInterop(toInteropTaskResultInterop(source))

  assert.equal(restored.kind, "success")
  if (restored.kind !== "success") assert.fail("expected a successful task result")
  assert.equal(restored.backgroundReason, "unknown-4096")
  assert.equal(restored.durationMs, 22n)
  assert.equal(restored.transcriptUri, "/tmp/transcript.jsonl")
  assert.deepEqual(projectSlateTaskResult(restored), {
    kind: "success",
    agentId: "agent-8",
    resultSuffix: "done",
    backgroundReason: "unknown-4096",
    transcriptUri: "/tmp/transcript.jsonl",
    finalAssistantText: "answer",
    chosenSummary: "summary",
  })
})

test("a failed run reads as its error", () => {
  assert.equal(renderTaskResultToString(errorResult("the subagent died")), "Error: the subagent died")
  assert.equal(renderTaskResultToString({ kind: "unknown" }), "Unknown error")
})

test("a rendered result carries whether it failed", () => {
  assert.equal(renderClientTaskResult(errorResult("the subagent died")).isError, true)
  assert.equal(renderClientTaskResult(successResult({ conversationSteps: [answerStep("done")] })).isError, false)
  assert.equal(renderClientTaskResult(errorResult("the subagent died")).content[0]?.text, "Error: the subagent died")
})

test("a thrown failure is serialized into the call's own error result", () => {
  const call = serializeError(new Error("no subagent to run")) as ToolCall
  assert.equal(call.tool.case, "taskToolCall")
  const value = (call.tool as { value: { result?: TaskResult } }).value
  assert.equal(value.result?.result?.case, "error")
  assert.equal((value.result?.result as { value: { error: string } }).value.error, "no subagent to run")
  assert.equal(((serializeError("just a string") as ToolCall).tool as { value: { result: { result: { value: { error: string } } } } }).value.result.result.value.error, "just a string")
})

function continuationConfigOf(value: unknown): SubagentContinuationConfig | undefined {
  return value as SubagentContinuationConfig | undefined
}

// ---------------------------------------------------------------------------------------------
// how a long-running subagent is kept going
// ---------------------------------------------------------------------------------------------

test("a subagent with no continuation policy is not continued", () => {
  assert.equal(buildClientContinuationConfig({ subagentType: GENERAL_PURPOSE }), undefined)
})

test("a policy's nudge and escape messages reach the platform", () => {
  const config = continuationConfigOf(buildClientContinuationConfig({
    subagentType: GENERAL_PURPOSE,
    continuationPolicy: { idleThreshold: 3, continuationMessage: "keep going" },
  }))
  assert.equal(config?.idleThreshold, 3)
  assert.equal(config?.maxLoops, 0)
  assert.equal(config?.nudgeMessage, "keep going")
  assert.match(config?.escapeMessageTemplate ?? "", /You've made \{idle_count\} responses without tool calls/)
  assert.equal(config?.collectBackgroundChildren, false)
})

test("a message written as a function is asked for both of its forms", () => {
  const asked: Array<{ isEscapeHatch: boolean; idleCount: number; escapeToken: string }> = []
  const config = continuationConfigOf(buildClientContinuationConfig({
    subagentType: GENERAL_PURPOSE,
    continuationPolicy: {
      idleThreshold: 5,
      maxLoops: 2,
      continuationMessage: (args) => {
        asked.push(args)
        return args.isEscapeHatch ? `stop after ${args.idleCount} with ${args.escapeToken}` : "keep going"
      },
    },
  }))
  assert.deepEqual(asked.map(entry => entry.isEscapeHatch), [false, true])
  assert.equal(config?.nudgeMessage, "keep going")
  // The sentinels the function saw are replaced with the placeholders the platform fills in.
  assert.equal(config?.escapeMessageTemplate, "stop after {idle_count} with {escape_token}")
  assert.equal(config?.maxLoops, 2)
})

test("only a coordinator is told about the children it left running", () => {
  const policy = { idleThreshold: 1, continuationMessage: "keep going" }
  const coordinator = continuationConfigOf(buildClientContinuationConfig({ subagentType: COORDINATOR, continuationPolicy: policy }))
  assert.equal(coordinator?.collectBackgroundChildren, true)
  assert.match(coordinator?.childrenCompletedMessageTemplate ?? "", /background agents have completed/)
  const other = continuationConfigOf(buildClientContinuationConfig({ subagentType: GENERAL_PURPOSE, continuationPolicy: policy }))
  assert.equal(other?.childrenCompletedMessageTemplate, "")
})

test("the retry hint is added only where it applies", () => {
  const hint = maybeAppendInterruptRetryHint(RUNNING_SUBAGENT_FOLLOWUP_ERROR, true, false)
  assert.equal(hint, `${RUNNING_SUBAGENT_FOLLOWUP_ERROR}\n${RUNNING_SUBAGENT_INTERRUPT_RETRY_HINT}`)
  assert.match(hint, /retry with `interrupt` set to true/)
  // Already interrupted, interrupts not enabled, or an unrelated error: the error stands as it is.
  assert.equal(maybeAppendInterruptRetryHint(RUNNING_SUBAGENT_FOLLOWUP_ERROR, true, true), RUNNING_SUBAGENT_FOLLOWUP_ERROR)
  assert.equal(maybeAppendInterruptRetryHint(RUNNING_SUBAGENT_FOLLOWUP_ERROR, false, false), RUNNING_SUBAGENT_FOLLOWUP_ERROR)
  assert.equal(maybeAppendInterruptRetryHint("something else", true, false), "something else")
})

// ---------------------------------------------------------------------------------------------
// running a subagent
// ---------------------------------------------------------------------------------------------

test("a run that answers comes back as its answer", async () => {
  const harnessed = executionHarness()
  const result = await harnessed.run()
  assert.equal(result.kind, "success")
  if (result.kind !== "success") assert.fail("expected a successful task result")
  assert.equal(result.conversationSteps.length, 1)
  const view = projectSlateTaskResult(result)
  assert.equal(view.kind === "success" ? view.finalAssistantText : undefined, "the answer")
  assert.equal(result.isBackground, false)
  assert.equal(typeof result.durationMs, "bigint")
  // The request that reached the executor is the resolved one, not the raw arguments.
  const executed = harnessed.executed[0]?.args
  assert.equal(executed?.toolCallId, "call-1")
  assert.equal(executed?.prompt, "do the thing")
  assert.equal(executed?.subagentType, "generalPurpose")
  assert.equal(executed?.modelId, "model-1")
  assert.equal(executed?.environment, "local")
})

test("a run that failed comes back as an error rather than throwing", async () => {
  const harnessed = executionHarness({ result: { status: "error", error: "the box was unreachable" } })
  const result = await harnessed.run()
  assert.deepEqual(result, { kind: "error", message: "the box was unreachable" })
})

test("a stream that was torn down is reported as transient", async () => {
  const harnessed = executionHarness({ fail: new WriteIterableClosedError("WritableIterable is closed") })
  const result = await harnessed.run()
  assert.equal(result.kind, "error")
  if (result.kind !== "error") assert.fail("expected a task error")
  assert.match(result.message, /connection closed before it finished/)
})

test("a follow-up to a running subagent is an error that says how to retry", async () => {
  const harnessed = executionHarness({
    result: { status: "success", agentId: "agent-1", toolCallCount: 0, backgroundReason: "queued-follow-up" },
  })
  const result = await harnessed.run()
  assert.deepEqual(result, { kind: "error", message: RUNNING_SUBAGENT_FOLLOWUP_ERROR })
})

test("a background run has no answer to show and keeps its transcript", async () => {
  const harnessed = executionHarness({
    result: {
      status: "success",
      agentId: "agent-1",
      toolCallCount: 0,
      backgroundReason: "agent-request",
      transcriptPath: "/tmp/transcript.jsonl",
    },
  })
  const result = await harnessed.run()
  assert.equal(result.kind, "success")
  if (result.kind !== "success") assert.fail("expected a successful task result")
  assert.equal(result.isBackground, true)
  assert.deepEqual(result.conversationSteps, [])
  assert.equal(result.transcriptUri, "/tmp/transcript.jsonl")
})

test("an unrecognized background reason stays background and round-trips through the result", async () => {
  const harnessed = executionHarness({
    result: { status: "success", agentId: "agent-unknown", toolCallCount: 0, backgroundReason: "unknown-4096" },
  })
  const result = await harnessed.run()
  assert.equal(result.kind, "success")
  if (result.kind !== "success") assert.fail("expected a successful task result")
  assert.equal(result.isBackground, true)
  assert.equal(result.backgroundReason, "unknown-4096")
  assert.deepEqual(result.conversationSteps, [])
})

test("a run's identity is recorded so a follow-up reaches it", async () => {
  const harnessed = executionHarness()
  await harnessed.run()
  assert.equal(harnessed.persisted.length, 1)
  assert.equal(harnessed.persisted[0]?.subagentId, "agent-1")
  assert.equal(harnessed.persisted[0]?.state.modelId, "model-1")
  // A local run has no box to remember.
  assert.equal(harnessed.persisted[0]?.state.cloudAgent, undefined)
})

test("a cloud run records the box it ran in", async () => {
  const harnessed = executionHarness({
    result: { status: "success", agentId: "bc-9", finalMessage: "done", toolCallCount: 0 },
  })
  await harnessed.run({ resolved: { effectiveEnvironment: "cloud" } })
  const state = harnessed.persisted[0]?.state
  assert.equal(state?.executionEnvironment, "cloud")
  assert.equal(state?.cloudAgent?.agentId, "bc-9")
})

test("a self-fork runs as a fork of this conversation", async () => {
  const harnessed = executionHarness()
  await harnessed.run({
    ctx: createContext().with(conversationIdKey, "conversation-1").with(conversationGroupIdKey, "group-1"),
    resolved: { isSelfForkRequested: true, subagentIdToResume: "agent-old" },
  })
  const executed = harnessed.executed[0]?.args
  assert.equal(executed?.forkAgentId, "conversation-1")
  // A fork is a new run, so the id it would have resumed is not sent.
  assert.equal(executed?.resumeAgentId, undefined)
  assert.equal(executed?.parentConversationId, "conversation-1")
  assert.equal(executed?.rootParentConversationId, "group-1")
})

test("a resumed run keeps its own base branch", async () => {
  const machine = { kind: "cloud-machine", baseBranch: "feature/other" }
  const resumed = executionHarness()
  await resumed.run({ resolved: { subagentIdToResume: "agent-old", effectiveTargetMachine: machine } })
  assert.equal(resumed.executed[0]?.args.resumeAgentId, "agent-old")
  // The branch a resumed run was created on is not replaced by the target machine's default.
  assert.equal(resumed.executed[0]?.args.cloudBaseBranch, undefined)
  const explicit = executionHarness()
  await explicit.run({ raw: { cloudBaseBranch: "feature/asked" }, resolved: { subagentIdToResume: "agent-old", effectiveTargetMachine: machine } })
  assert.equal(explicit.executed[0]?.args.cloudBaseBranch, "feature/asked")
})

test("a fresh cloud run takes the branch the request or the machine asked for", async () => {
  const fromMachine = executionHarness()
  await fromMachine.run({ resolved: { effectiveTargetMachine: { kind: "cloud-machine", baseBranch: "feature/machine" } } })
  assert.equal(fromMachine.executed[0]?.args.cloudBaseBranch, "feature/machine")
  const fromRequest = executionHarness()
  await fromRequest.run({
    raw: { cloudBaseBranch: "feature/asked" },
    resolved: { effectiveTargetMachine: { kind: "cloud-machine", baseBranch: "feature/machine" } },
  })
  assert.equal(fromRequest.executed[0]?.args.cloudBaseBranch, "feature/asked")
})

test("a run that is being steered hands itself to the background", async () => {
  const harnessed = executionHarness()
  harnessed.signal.pending = true
  await harnessed.run({ signal: true })
  assert.deepEqual(harnessed.handoffs, ["call-1"])
})

test("a finished run stops asking to be backgrounded", async () => {
  // The handoff is refused, which leaves the retry that keeps an unserved injection alive armed — until
  // the run itself ends, which is when it has to stop.
  const harnessed = executionHarness({ forceBackgroundStatus: "not-found" })
  harnessed.signal.pending = true
  await harnessed.run({ signal: true })
  assert.equal(harnessed.handoffs.length, 1)
  harnessed.signal.pending = true
  for (const listener of [...harnessed.injections]) listener()
  await new Promise(resolve => setTimeout(resolve, 600))
  assert.equal(harnessed.handoffs.length, 1)
})

test("a run that is already in the background is never handed off", async () => {
  const harnessed = executionHarness()
  harnessed.signal.pending = true
  await harnessed.run({ raw: { runInBackground: true }, signal: true })
  assert.deepEqual(harnessed.handoffs, [])
})
