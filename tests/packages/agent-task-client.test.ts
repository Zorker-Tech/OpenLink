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
import type { TaskRawArguments, TaskSubagentResolution } from "../../source/packages/agent/tools/task-subagent-preparation.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { conversationIdKey, conversationGroupIdKey } from "../../source/packages/agent/utils/request-scope.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { subagentExecutorResource, RUNNING_SUBAGENT_FOLLOWUP_ERROR, RUNNING_SUBAGENT_INTERRUPT_RETRY_HINT } from "../../source/packages/agent-exec/subagent.ts"
import { forceBackgroundSubagentExecutorResource } from "../../source/packages/agent-exec/subagent-control.ts"
import { WriteIterableClosedError } from "../../source/packages/utils/writable-iterable.ts"
import {
  AssistantMessage,
  ConversationStep,
  SubagentBackgroundReason,
  SubagentExecutionEnvironment,
  SubagentPersistedState,
  TaskError,
  TaskResult,
  TaskSuccess,
  ToolCall,
  type ConversationStep as ConversationStepValue,
} from "../../source/packages/proto/generated/agent/v1/agent_pb.ts"
import {
  ForceBackgroundSubagentStatus,
  SubagentArgs,
  SubagentResult,
  SubagentSuccess,
} from "../../source/packages/proto/generated/agent/v1/subagent_exec_pb.ts"
import { SendFinalSummaryArgs, SendFinalSummaryToolCall } from "../../source/packages/proto/generated/agent/v1/send_final_summary_tool_pb.ts"
import {
  SubagentType,
  SubagentTypeCustom,
  SubagentTypeUnspecified,
} from "../../source/packages/proto/generated/agent/v1/subagents_pb.ts"

// ---------------------------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------------------------

const GENERAL_PURPOSE = new SubagentType({ type: { case: "unspecified", value: new SubagentTypeUnspecified({}) } })
const COORDINATOR = new SubagentType({ type: { case: "custom", value: new SubagentTypeCustom({ name: "coordinator-agent" }) } })

const answerStep = (text: string): ConversationStepValue =>
  new ConversationStep({ message: { case: "assistantMessage", value: new AssistantMessage({ text }) } })

const summaryStep = (finalSummary: string): ConversationStepValue =>
  new ConversationStep({
    message: {
      case: "toolCall",
      value: new ToolCall({ tool: { case: "sendFinalSummaryToolCall", value: new SendFinalSummaryToolCall({ args: { finalSummary } } as never) } }),
    },
  })

const successResult = (fields: {
  conversationSteps?: ConversationStepValue[]
  backgroundReason?: SubagentBackgroundReason
  transcriptPath?: string
  agentId?: string
  resultSuffix?: string
} = {}) => new TaskResult({
  result: {
    case: "success",
    value: new TaskSuccess({
      conversationSteps: fields.conversationSteps ?? [],
      durationMs: 12n,
      isBackground: (fields.backgroundReason ?? SubagentBackgroundReason.UNSPECIFIED) !== SubagentBackgroundReason.UNSPECIFIED,
      backgroundReason: fields.backgroundReason ?? SubagentBackgroundReason.UNSPECIFIED,
      ...(fields.transcriptPath === undefined ? {} : { transcriptPath: fields.transcriptPath }),
      ...(fields.agentId === undefined ? {} : { agentId: fields.agentId }),
      ...(fields.resultSuffix === undefined ? {} : { resultSuffix: fields.resultSuffix }),
    }),
  },
})

const errorResult = (error: string) =>
  new TaskResult({ result: { case: "error", value: new TaskError({ error }) } })

function resolution(overrides: Record<string, unknown> = {}): TaskSubagentResolution {
  return {
    subagentConfig: { subagent_type: GENERAL_PURPOSE, isBackground: false },
    effectiveReadonly: false,
    useAskModeForSubagent: false,
    typeName: "generalPurpose",
    analyticsSubagentType: "generalPurpose",
    resolvedModelId: "model-1",
    subagentId: "subagent-1",
    isResume: false,
    subagentRequestId: "request-1",
    isSelfForkRequested: false,
    effectiveEnvironment: SubagentExecutionEnvironment.LOCAL,
    effectiveTargetMachine: { type: "same_machine" },
    ...overrides,
  } as unknown as TaskSubagentResolution
}

const rawArgs = (overrides: Partial<TaskRawArguments> = {}): TaskRawArguments => ({ prompt: "do the thing", ...overrides })

interface Executed {
  readonly args: SubagentArgs
  readonly ctx: Context
}

/** A run that answers: the executor records the request it was handed and returns the result asked for. */
function executionHarness(options: {
  result?: SubagentResult
  fail?: Error
  forceBackgroundStatus?: ForceBackgroundSubagentStatus
} = {}) {
  const executed: Executed[] = []
  const handoffs: string[] = []
  const persisted: Array<{ subagentId: string; state: SubagentPersistedState }> = []
  const injections: Array<() => void> = []
  const subagentExecutor = {
    async execute(ctx: Context, args: SubagentArgs) {
      executed.push({ args, ctx })
      if (options.fail !== undefined) throw options.fail
      return options.result ?? new SubagentResult({ result: { case: "success", value: new SubagentSuccess({ agentId: "agent-1", finalMessage: "the answer" }) } })
    },
  }
  const forceBackgroundExecutor = {
    async execute(_ctx: Context, args: { toolCallId: string }) {
      handoffs.push(args.toolCallId)
      return { status: options.forceBackgroundStatus ?? ForceBackgroundSubagentStatus.ACCEPTED }
    },
  }
  const accessor = {
    get: (resource: unknown) => resource === subagentExecutorResource ? subagentExecutor : forceBackgroundExecutor,
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
  const run = (args: {
    ctx?: Context
    raw?: Partial<TaskRawArguments>
    resolved?: Record<string, unknown>
    signal?: boolean
  } = {}) => executeClientSideTaskSubagent({
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
  await harnessed.run({ raw: { run_in_background: true } })
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
    backgroundReason: SubagentBackgroundReason.AGENT_REQUEST,
    transcriptPath: "/tmp/transcript.jsonl",
  }))
  assert.match(rendered, /^Subagent is running in the background\./)
  assert.match(rendered, /tailing the transcript at: \/tmp\/transcript\.jsonl/)
  assert.equal(rendered.includes("<response>"), false)
})

test("with completion notifications the note says the answer arrives on its own", () => {
  const rendered = renderTaskResultToString(
    successResult({ backgroundReason: SubagentBackgroundReason.AGENT_REQUEST, transcriptPath: "/tmp/transcript.jsonl" }),
    { enableJobCompletionNotifications: true },
  )
  assert.match(rendered, /you will be automatically sent the subagent's final response/)
  assert.match(rendered, /Do NOT mention the transcript path to the user/)
})

test("a background run without a transcript is told only that it is running", () => {
  assert.equal(
    formatSubagentBackgroundMessage(SubagentBackgroundReason.AGENT_REQUEST, "   "),
    "Subagent is running in the background.",
  )
  assert.equal(
    formatSubagentBackgroundMessage(SubagentBackgroundReason.USER_REQUEST, undefined),
    "The user manually backgrounded the subagent. It is still running; you can continue with other work.",
  )
  assert.equal(
    formatSubagentBackgroundMessage(SubagentBackgroundReason.QUEUED_FOLLOW_UP, undefined),
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

test("a failed run reads as its error", () => {
  assert.equal(renderTaskResultToString(errorResult("the subagent died")), "Error: the subagent died")
  assert.equal(renderTaskResultToString(new TaskResult()), "Unknown error")
})

test("a rendered result carries whether it failed", () => {
  assert.equal(renderClientTaskResult(errorResult("the subagent died")).isError, true)
  assert.equal(renderClientTaskResult(successResult({ conversationSteps: [answerStep("done")] })).isError, false)
  assert.equal(renderClientTaskResult(errorResult("the subagent died")).content[0]?.text, "Error: the subagent died")
})

test("a thrown failure is serialized into the call's own error result", () => {
  const call = serializeError(new Error("no subagent to run"))
  assert.equal(call.tool.case, "taskToolCall")
  const value = (call.tool as { value: { result?: TaskResult } }).value
  assert.equal(value.result?.result?.case, "error")
  assert.equal((value.result?.result as { value: { error: string } }).value.error, "no subagent to run")
  assert.equal((serializeError("just a string").tool as { value: { result: { result: { value: { error: string } } } } }).value.result.result.value.error, "just a string")
})

// ---------------------------------------------------------------------------------------------
// how a long-running subagent is kept going
// ---------------------------------------------------------------------------------------------

test("a subagent with no continuation policy is not continued", () => {
  assert.equal(buildClientContinuationConfig({ subagent_type: GENERAL_PURPOSE }), undefined)
})

test("a policy's nudge and escape messages reach the platform", () => {
  const config = buildClientContinuationConfig({
    subagent_type: GENERAL_PURPOSE,
    continuationPolicy: { idleThreshold: 3, continuationMessage: "keep going" },
  })
  assert.equal(config?.idleThreshold, 3)
  assert.equal(config?.maxLoops, 0)
  assert.equal(config?.nudgeMessage, "keep going")
  assert.match(config?.escapeMessageTemplate ?? "", /You've made \{idle_count\} responses without tool calls/)
  assert.equal(config?.collectBackgroundChildren, false)
})

test("a message written as a function is asked for both of its forms", () => {
  const asked: Array<{ isEscapeHatch: boolean; idleCount: number; escapeToken: string }> = []
  const config = buildClientContinuationConfig({
    subagent_type: GENERAL_PURPOSE,
    continuationPolicy: {
      idleThreshold: 5,
      maxLoops: 2,
      continuationMessage: (args) => {
        asked.push(args)
        return args.isEscapeHatch ? `stop after ${args.idleCount} with ${args.escapeToken}` : "keep going"
      },
    },
  })
  assert.deepEqual(asked.map(entry => entry.isEscapeHatch), [false, true])
  assert.equal(config?.nudgeMessage, "keep going")
  // The sentinels the function saw are replaced with the placeholders the platform fills in.
  assert.equal(config?.escapeMessageTemplate, "stop after {idle_count} with {escape_token}")
  assert.equal(config?.maxLoops, 2)
})

test("only a coordinator is told about the children it left running", () => {
  const policy = { idleThreshold: 1, continuationMessage: "keep going" }
  const coordinator = buildClientContinuationConfig({ subagent_type: COORDINATOR, continuationPolicy: policy })
  assert.equal(coordinator?.collectBackgroundChildren, true)
  assert.match(coordinator?.childrenCompletedMessageTemplate ?? "", /background agents have completed/)
  const other = buildClientContinuationConfig({ subagent_type: GENERAL_PURPOSE, continuationPolicy: policy })
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
  assert.equal(result.result.case, "success")
  const success = (result.result as { value: TaskSuccess }).value
  assert.equal(success.conversationSteps.length, 1)
  assert.equal((success.conversationSteps[0]?.message as { value: { text: string } }).value.text, "the answer")
  assert.equal(success.isBackground, false)
  assert.equal(typeof success.durationMs, "bigint")
  // The request that reached the executor is the resolved one, not the raw arguments.
  const executed = harnessed.executed[0]?.args
  assert.equal(executed?.toolCallId, "call-1")
  assert.equal(executed?.prompt, "do the thing")
  assert.equal(executed?.subagentType, "generalPurpose")
  assert.equal(executed?.modelId, "model-1")
  assert.equal(executed?.environment, SubagentExecutionEnvironment.LOCAL)
})

test("a run that failed comes back as an error rather than throwing", async () => {
  const harnessed = executionHarness({ result: new SubagentResult({ result: { case: "error", value: { error: "the box was unreachable" } } as never }) })
  const result = await harnessed.run()
  assert.equal(result.result.case, "error")
  assert.equal((result.result as { value: { error: string } }).value.error, "the box was unreachable")
})

test("a stream that was torn down is reported as transient", async () => {
  const harnessed = executionHarness({ fail: new WriteIterableClosedError("WritableIterable is closed") })
  const result = await harnessed.run()
  assert.equal(result.result.case, "error")
  assert.match((result.result as { value: { error: string } }).value.error, /connection closed before it finished/)
})

test("a follow-up to a running subagent is an error that says how to retry", async () => {
  const harnessed = executionHarness({
    result: new SubagentResult({
      result: {
        case: "success",
        value: new SubagentSuccess({ backgroundReason: SubagentBackgroundReason.QUEUED_FOLLOW_UP }),
      },
    }),
  })
  const result = await harnessed.run()
  assert.equal(result.result.case, "error")
  assert.equal((result.result as { value: { error: string } }).value.error, RUNNING_SUBAGENT_FOLLOWUP_ERROR)
})

test("a background run has no answer to show and keeps its transcript", async () => {
  const harnessed = executionHarness({
    result: new SubagentResult({
      result: {
        case: "success",
        value: new SubagentSuccess({
          agentId: "agent-1",
          backgroundReason: SubagentBackgroundReason.AGENT_REQUEST,
          transcriptPath: "/tmp/transcript.jsonl",
        }),
      },
    }),
  })
  const result = await harnessed.run()
  const success = (result.result as { value: TaskSuccess }).value
  assert.equal(success.isBackground, true)
  assert.deepEqual(success.conversationSteps, [])
  assert.equal(success.transcriptPath, "/tmp/transcript.jsonl")
})

test("a run's identity is recorded so a follow-up reaches it", async () => {
  const harnessed = executionHarness()
  await harnessed.run()
  assert.equal(harnessed.persisted.length, 1)
  assert.equal(harnessed.persisted[0]?.subagentId, "agent-1")
  assert.equal(harnessed.persisted[0]?.state.modelId, "model-1")
  // A local run has no box to remember.
  assert.equal(harnessed.persisted[0]?.state.cloudSubagent, undefined)
})

test("a cloud run records the box it ran in", async () => {
  const harnessed = executionHarness({
    result: new SubagentResult({ result: { case: "success", value: new SubagentSuccess({ agentId: "bc-9", finalMessage: "done" }) } }),
  })
  await harnessed.run({ resolved: { effectiveEnvironment: SubagentExecutionEnvironment.CLOUD } })
  const state = harnessed.persisted[0]?.state
  assert.equal(state?.environment, SubagentExecutionEnvironment.CLOUD)
  assert.equal(state?.cloudSubagent?.bcId, "bc-9")
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
  const machine = { type: "new_cloud_vm", base_branch: "feature/other" }
  const resumed = executionHarness()
  await resumed.run({ resolved: { subagentIdToResume: "agent-old", effectiveTargetMachine: machine } })
  assert.equal(resumed.executed[0]?.args.resumeAgentId, "agent-old")
  // The branch a resumed run was created on is not replaced by the target machine's default.
  assert.equal(resumed.executed[0]?.args.cloudBaseBranch, undefined)
  const explicit = executionHarness()
  await explicit.run({ raw: { cloud_base_branch: "feature/asked" }, resolved: { subagentIdToResume: "agent-old", effectiveTargetMachine: machine } })
  assert.equal(explicit.executed[0]?.args.cloudBaseBranch, "feature/asked")
})

test("a fresh cloud run takes the branch the request or the machine asked for", async () => {
  const fromMachine = executionHarness()
  await fromMachine.run({ resolved: { effectiveTargetMachine: { type: "new_cloud_vm", base_branch: "feature/machine" } } })
  assert.equal(fromMachine.executed[0]?.args.cloudBaseBranch, "feature/machine")
  const fromRequest = executionHarness()
  await fromRequest.run({
    raw: { cloud_base_branch: "feature/asked" },
    resolved: { effectiveTargetMachine: { type: "new_cloud_vm", base_branch: "feature/machine" } },
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
  const harnessed = executionHarness({ forceBackgroundStatus: ForceBackgroundSubagentStatus.NOT_FOUND })
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
  await harnessed.run({ raw: { run_in_background: true }, signal: true })
  assert.deepEqual(harnessed.handoffs, [])
})