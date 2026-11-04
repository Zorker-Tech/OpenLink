import { test } from "node:test"
import assert from "node:assert/strict"

import { AsyncAskQuestionCompletionActionHandler } from "../../source/packages/agent/actions/async-ask-question-completion-action-handler.ts"
import { BackgroundTaskCompletionActionHandler } from "../../source/packages/agent/actions/background-task-completion-action-handler.ts"
import { ExecutePlanActionHandler } from "../../source/packages/agent/actions/execute-plan-action-handler.ts"
import { ResumeActionHandler } from "../../source/packages/agent/actions/user-message-action/resume-action-handler.ts"
import { UserMessageActionHandler } from "../../source/packages/agent/actions/user-message-action/user-message-action-handler.ts"
import { AbstractUserMessageActionHandler } from "../../source/packages/agent/actions/user-message-action/abstract-user-message-action-handler.ts"
import { createContext } from "../../source/packages/context/context.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import {
  BackgroundTaskCompletion,
  BackgroundTaskCompletionAction,
  BackgroundTaskCompletionReason,
  BackgroundTaskKind,
  BackgroundTaskStatus,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { toRedactedBackgroundTaskCompletionAction } from "../../source/adapters/interop/redacted-protos/generated/agent/v1/agent_redacted.ts"
import { requestContextExecutorResource } from "../../source/packages/agent-exec/request-context-operation.ts"
import { RequestContext } from "../../source/adapters/interop/proto/generated/agent/v1/request_context_exec_pb.ts"
import { toRedactedCoreMessages } from "../../source/packages/redaction/message-redaction.ts"
import { ConversationStateHandle } from "../../source/packages/agent/state.ts"
import {
  toRedactedConversationStateStructure,
  toRedactedShellCommand,
  toRedactedAsyncAskQuestionCompletionAction,
} from "../../source/adapters/interop/redacted-protos/generated/agent/v1/agent_redacted.ts"
import { AskQuestionArgs, AskQuestionResult, AskQuestionSuccess } from "../../source/adapters/interop/proto/generated/agent/v1/ask_question_tool_pb.ts"
import { AgentMode, AsyncAskQuestionCompletionAction, ConversationStateStructure, ShellCommand, UserMessage } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { AgentType } from "../../source/packages/agent/utils/agent-config.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"

// ---------------------------------------------------------------------------------------------
// The action handlers are the ways a turn can start. Each is handed the action and the things a turn
// talks to, so the fakes below are what a turn needs and nothing more.
// ---------------------------------------------------------------------------------------------

const USER_INFO_TAG = "<user_info>"

type Config = ConstructorParameters<typeof AbstractUserMessageActionHandler>[0]
type Listener = ConstructorParameters<typeof AbstractUserMessageActionHandler>[2]
type HandlerConstructor = new (...args: ConstructorParameters<typeof AbstractUserMessageActionHandler>) => AbstractUserMessageActionHandler

function createHandler<T extends AbstractUserMessageActionHandler>(
  ctor: HandlerConstructor,
  config: Record<string, unknown> = {},
): { handler: T; updates: unknown[] } {
  const updates: unknown[] = []
  const listener = {
    sendUpdate: async (_ctx: unknown, update: unknown) => {
      updates.push(update)
    },
    enqueuePostTurnEndedWork: () => {},
  } as unknown as Listener
  const handler = new ctor(
    { backgroundSummarizationProps: {}, ...config } as unknown as Config,
    {
      get: (resource: unknown) =>
        resource === requestContextExecutorResource
          ? {
            execute: async () => ({
              result: { case: "success", value: { requestContext: new RequestContext({}) } },
            }),
          }
          : undefined,
    } as unknown as ConstructorParameters<typeof AbstractUserMessageActionHandler>[1],
    listener,
    undefined,
    {} as unknown as ConstructorParameters<typeof AbstractUserMessageActionHandler>[4],
    {} as unknown as ConstructorParameters<typeof AbstractUserMessageActionHandler>[5],
  ) as T
  return { handler, updates }
}

function createPromptExecutor(messages: unknown[] = []) {
  const appended: unknown[] = []
  return {
    appended,
    getMessages: () => messages,
    appendMessages: (next: readonly unknown[]) => {
      appended.push(...next)
    },
  }
}

function createStateHandler(overrides: Record<string, unknown> = {}) {
  return {
    turns: [] as unknown[],
    mode: undefined,
    isRootProjectConversation: true,
    getPrivacyMode: () => PrivacyMode.UNSPECIFIED,
    usesLargeContextTreatment: () => false,
    computeNewStructure: async () => ({ computed: true }),
    recordSubagentRunCompletion: () => {},
    hasCompletedAskQuestion: () => false,
    hasAgentTypeChangedFromPersistedState: () => false,
    getSubagentThreadId: () => undefined,
    markAskQuestionCompleted: () => {},
    getRawPendingMessages: () => [],
    createAgentTurn: async () => ({ created: true }),
    ...overrides,
  }
}

const USER_MESSAGE = { text: "hello", messageId: "m1" }

/** A conversation state over a blob store, so the turns a handler reads are real turns. */
function createConversationState(structure = new ConversationStateStructure({})) {
  const blobs = new Map<string, Uint8Array>()
  const keyOf = (id: Uint8Array) => Buffer.from(id).toString("hex")
  const blobStore = {
    async getBlob(_ctx: unknown, blobId: Uint8Array) {
      return blobs.get(keyOf(blobId))
    },
    async setBlob(_ctx: unknown, blobId: Uint8Array, data: Uint8Array) {
      blobs.set(keyOf(blobId), data)
    },
    async setBlobLocallyOnly(_ctx: unknown, blobId: Uint8Array, data: Uint8Array) {
      blobs.set(keyOf(blobId), data)
    },
    async flush() {},
  }
  const builder = { appendMessages() {}, getState: () => [], clearMessages() {} }
  return new ConversationStateHandle(
    blobStore as never,
    toRedactedConversationStateStructure(structure, PrivacyMode.NO_STORAGE),
    builder as never,
    {},
    "composer-2",
  )
}

/** A conversation state holding an agent turn, which is the kind a turn handler recognizes. */
async function stateWithAgentTurn() {
  const state = createConversationState()
  const turn = await state.createAgentTurn(
    createContext(),
    new UserMessage({ text: "what is the answer", messageId: "m1", isSimulatedMsg: true }),
    new RequestContext({}) as never,
    {} as never,
    undefined,
  )
  return { state, turn }
}

async function stateWithShellTurn() {
  const state = createConversationState()
  const turn = await state.createShellTurn(
    createContext(),
    toRedactedShellCommand(new ShellCommand({ command: "pwd" }), PrivacyMode.NO_STORAGE),
  )
  return { state, turn }
}

/** A user message as the conversation holds it: redacted, with its parts rather than a plain string. */
function userMessages(text: string): readonly unknown[] {
  return toRedactedCoreMessages([{ role: "user", content: [{ type: "text", text }] }], PrivacyMode.UNSPECIFIED)
}

// ---------------------------------------------------------------------------------------------
// A plan is the first message of its conversation, so the user info it carries has to be kept current
// ---------------------------------------------------------------------------------------------

test("a conversation is not re-rendered from a message that carries no user info", () => {
  const { handler } = createHandler<ExecutePlanActionHandler>(ExecutePlanActionHandler)
  const state = createStateHandler()

  assert.equal(handler.shouldRerenderUserInfo([], state, {}), false)
  assert.equal(handler.shouldRerenderUserInfo([{ role: "system", content: "prompt" }], state, {}), false)
  assert.equal(handler.shouldRerenderUserInfo(userMessages("just a question"), state, {}), false)
})

test("the user info is re-rendered when the session is no longer the one it describes", () => {
  const { handler } = createHandler<ExecutePlanActionHandler>(ExecutePlanActionHandler)
  const message = userMessages(`here is what you need\n${USER_INFO_TAG}\n...\n${USER_INFO_TAG.replace("<", "</")}`)

  // A session that has not moved on keeps the info it wrote.
  assert.equal(handler.shouldRerenderUserInfo(message, createStateHandler(), {}), false)
  // One whose agent type changed does not.
  const changed = createStateHandler({ hasAgentTypeChangedFromPersistedState: () => true })
  assert.equal(handler.shouldRerenderUserInfo(message, changed, {}), true)
})

test("the metadata of the first user info is read back as it was written", () => {
  const { handler } = createHandler<ExecutePlanActionHandler>(ExecutePlanActionHandler)
  const withMetadata = [
    {
      role: "user",
      content: "anything",
      providerOptions: {
        cursor: { requestContextCompleteness: { files: true }, userInfoSummarizationEpoch: 42, omitCloudWorkerProcedure: true },
      },
    },
  ]

  // An epoch is a whole number of summaries, and anything else is nothing at all.
  assert.equal(handler.getFirstUserInfoSummarizationEpoch(withMetadata), 42)
  assert.equal(handler.getFirstUserInfoSummarizationEpoch([{ role: "user", content: "x" }]), undefined)
  assert.equal(handler.getFirstUserInfoOmitCloudWorkerProcedure(withMetadata), true)
  assert.equal(handler.getFirstUserInfoOmitCloudWorkerProcedure([{ role: "user", content: "x" }]), false)
  // A completeness that is missing any of its parts describes nothing.
  assert.equal(handler.getFirstUserInfoRequestContextCompleteness(withMetadata), undefined)
  assert.equal(handler.getFirstUserInfoRequestContextCompleteness([{ role: "system", content: "x" }]), undefined)
})

test("plan execution uses Slate chat mode across policy and encodes only the stored message", async () => {
  const toolModes: unknown[] = []
  const promptModes: unknown[] = []
  const storedMessages: UserMessage[] = []
  let stateMode: unknown
  const toolSet = {
    getAllTools: () => [],
    getStaticTools: () => [],
    getDescriptionProps: () => ({ allTools: {} }),
    hasTool: () => false,
    getTool: () => undefined,
    getStaticTool: () => undefined,
    getDynamicToolRegistry: () => undefined,
  }
  const { handler } = createHandler<ExecutePlanActionHandler>(ExecutePlanActionHandler, {
    agentType: AgentType.IDE,
    agentSessionId: "session-1",
    nonFileRules: [],
    featureFlags: {},
    userInfoDisplayOptions: { disable: true },
    toolsGenerator: (input: { mode: unknown }) => {
      toolModes.push(input.mode)
      return toolSet
    },
    systemPromptGenerator: (input: { mode: unknown }) => {
      promptModes.push(input.mode)
      return "system prompt"
    },
  })
  const state = createStateHandler({
    plan: undefined,
    todos: [],
    summaryArchives: [],
    setTodos() {},
    upsertPlanEntry() {},
    getBlobStore() { return undefined },
    usesLargeContextTreatment() { return false },
    setMode(mode: unknown) { stateMode = mode },
    async createAgentTurn(_ctx: unknown, message: UserMessage) {
      storedMessages.push(message)
      return { created: true }
    },
  })
  const promptMessages: any[] = []
  const prompt = {
    getMessages: () => promptMessages,
    appendMessages(next: readonly unknown[]) { promptMessages.push(...next) },
    clearMessages() { promptMessages.length = 0 },
  }
  const action = {
    planFileContent: { unwrap: () => "# Plan\nDo the work." },
    planFilePath: { unwrap: () => "/repo/plan.md" },
    executionMode: AgentMode.ASK,
    planId: "plan-1",
    kickoffMessageId: "message-1",
    _privacyMode: PrivacyMode.NO_STORAGE,
  }

  await handler.initializeConversation(createContext(), action, prompt, state, [])

  assert.deepEqual(toolModes, [SlateMode.CHAT])
  assert.deepEqual(promptModes, [SlateMode.CHAT])
  assert.equal(stateMode, SlateMode.CHAT)
  assert.equal(storedMessages[0]?.mode, AgentMode.ASK)
})

// ---------------------------------------------------------------------------------------------
// An answer to a question that was asked asynchronously
// ---------------------------------------------------------------------------------------------

function askQuestionCompletion(overrides: Record<string, unknown> = {}) {
  const action = new AsyncAskQuestionCompletionAction({
    originalToolCallId: "call-1",
    originalArgs: new AskQuestionArgs({ title: "A follow-up" }),
    result: new AskQuestionResult({ result: { case: "success", value: new AskQuestionSuccess() } }),
    ...overrides,
  })
  return toRedactedAsyncAskQuestionCompletionAction(action, PrivacyMode.UNSPECIFIED)
}

test("an answer that is not an answer is left alone", async () => {
  const { handler, updates } = createHandler<AsyncAskQuestionCompletionActionHandler>(AsyncAskQuestionCompletionActionHandler)
  const { state } = await stateWithAgentTurn()
  const result = await handler.handle(createContext(), askQuestionCompletion({ result: undefined }), createPromptExecutor(), state, [], undefined)

  // The turn it would have been written into is untouched, and nobody is told a question was answered.
  assert.equal(updates.length, 0)
  assert.equal((result as { turns: readonly unknown[] }).turns.length, 1)
})

test("an answer that was already applied is not applied again", async () => {
  const { handler, updates } = createHandler<AsyncAskQuestionCompletionActionHandler>(AsyncAskQuestionCompletionActionHandler)
  const { state } = await stateWithAgentTurn()
  state.markAskQuestionCompleted("call-1")

  await handler.handle(createContext(), askQuestionCompletion(), createPromptExecutor(), state, [], undefined)
  assert.equal(updates.length, 0)
})

test("an answer with no turn to attach to is left alone", async () => {
  const { handler, updates } = createHandler<AsyncAskQuestionCompletionActionHandler>(AsyncAskQuestionCompletionActionHandler)
  const state = createConversationState()
  await handler.handle(createContext(), askQuestionCompletion(), createPromptExecutor(), state, [], undefined)

  assert.equal(updates.length, 0)
})

test("a completion after a finished turn opens a continuation and runs it", async () => {
  const { handler, updates } = createHandler<AsyncAskQuestionCompletionActionHandler>(AsyncAskQuestionCompletionActionHandler)
  const { state } = await stateWithAgentTurn()
  state.computeNewStructure = async () => ({ computed: true }) as never
  const appended: unknown[] = []
  const prompt = createPromptExecutor()
  const createdUsers: UserMessage[] = []
  const loopCalls: unknown[][] = []
  const toolsGenerator = () => ({})
  const continuationTurn = {
    async upsertToolCall(_ctx: unknown, toolCall: unknown, toolCallId: string) {
      appended.push([toolCallId, toolCall])
    },
  }
  state.createAgentTurn = async (_ctx, userMessage) => {
    createdUsers.push(userMessage as UserMessage)
    return continuationTurn as never
  }
  Object.assign(handler, {
    mergeRequestContextTools: (_tools: unknown, _requestTools: unknown) => [],
    runTurnLoop: async (...args: unknown[]) => { loopCalls.push(args) },
  })
  ;(handler as unknown as { config: Record<string, unknown> }).config.toolsGenerator = toolsGenerator

  const result = await handler.handle(createContext(), askQuestionCompletion(), prompt, state, [], undefined)

  assert.deepEqual(result, { computed: true })
  assert.equal(createdUsers.length, 1)
  assert.equal(createdUsers[0]?.text, "Continue with the questionnaire results.")
  assert.equal(createdUsers[0]?.isSimulatedMsg, true)
  assert.equal(updates.length, 1)
  assert.equal(appended.length, 1)
  assert.equal(prompt.appended.length, 2)
  assert.equal(loopCalls.length, 1)
  assert.equal(loopCalls[0]?.[3], continuationTurn)
  assert.equal(loopCalls[0]?.[4], toolsGenerator)
})

test("a completion during an active turn is appended to that turn before its loop runs", async () => {
  const { handler } = createHandler<AsyncAskQuestionCompletionActionHandler>(AsyncAskQuestionCompletionActionHandler)
  const { state, turn } = await stateWithAgentTurn()
  state.computeNewStructure = async () => ({ computed: true }) as never
  turn.steps.push({ get: async () => ({
    kind: "tool-call",
    toolCallId: "call-before-completion",
    hookContexts: [],
    tool: { case: undefined },
  }) } as never)
  const appended: unknown[] = []
  const prompt = createPromptExecutor()
  const loopCalls: unknown[][] = []
  const toolsGenerator = () => ({})
  const upsertToolCall = turn.upsertToolCall.bind(turn)
  turn.upsertToolCall = async (...args) => {
    appended.push(args[2])
    return await upsertToolCall(...args)
  }
  Object.assign(handler, {
    mergeRequestContextTools: () => [],
    runTurnLoop: async (...args: unknown[]) => { loopCalls.push(args) },
  })
  ;(handler as unknown as { config: Record<string, unknown> }).config.toolsGenerator = toolsGenerator

  const result = await handler.handle(createContext(), askQuestionCompletion(), prompt, state, [], undefined)

  assert.deepEqual(result, { computed: true })
  assert.deepEqual(appended, ["call-1"])
  assert.equal(prompt.appended.length, 2)
  assert.equal(loopCalls.length, 1)
  assert.equal(loopCalls[0]?.[3], turn)
  assert.equal(loopCalls[0]?.[4], toolsGenerator)
})

// ---------------------------------------------------------------------------------------------
// Resuming a conversation that was interrupted
// ---------------------------------------------------------------------------------------------

test("a resume with nothing pending has nothing to execute", async () => {
  const { handler } = createHandler<ResumeActionHandler>(ResumeActionHandler)
  const { state } = await stateWithShellTurn()
  // The conversation has a turn, so the refusal comes from the empty pending list rather than from nothing
  // to resume.
  assert.equal(await handler.executePendingToolCalls(createContext(), state, [], {}, "invocation"), false)
})

test("a resume with no turns reports that there is nothing to resume", async () => {
  const { handler } = createHandler<ResumeActionHandler>(ResumeActionHandler)
  const state = createStateHandler()
  const setup = await handler.setupResumeStep(createContext(), {}, state, [])

  assert.equal("noTurns" in setup, true)
})

// ---------------------------------------------------------------------------------------------
// Work that finished in the background
// ---------------------------------------------------------------------------------------------

function completion(overrides: Record<string, unknown> = {}) {
  return new BackgroundTaskCompletion({
    taskId: "task-1",
    kind: BackgroundTaskKind.SUBAGENT,
    status: BackgroundTaskStatus.SUCCESS,
    title: "the subagent finished",
    ...overrides,
  })
}

function completionAction(completions: readonly BackgroundTaskCompletion[]) {
  return toRedactedBackgroundTaskCompletionAction(
    new BackgroundTaskCompletionAction({ completions: [...completions] }),
    PrivacyMode.UNSPECIFIED,
  )
}

test("a follow-up that was turned off is skipped, and the completion is still recorded", async () => {
  const recorded: unknown[] = []
  const { handler } = createHandler<BackgroundTaskCompletionActionHandler>(BackgroundTaskCompletionActionHandler, {
    featureFlags: { disableBackgroundTaskFollowUp: true },
  })
  const state = createStateHandler({ recordSubagentRunCompletion: (value: unknown) => recorded.push(value) })
  const followup = await handler.prepareFollowupTurn(
    createContext(),
    completionAction([completion()]),
    createPromptExecutor(),
    state,
    [],
  )

  assert.equal(followup.kind, "skip")
  assert.equal(recorded.length, 1)
})

test("an empty set of completions is skipped", async () => {
  const { handler } = createHandler<BackgroundTaskCompletionActionHandler>(BackgroundTaskCompletionActionHandler)
  const followup = await handler.prepareFollowupTurn(
    createContext(),
    completionAction([]),
    createPromptExecutor(),
    createStateHandler(),
    [],
  )

  assert.equal(followup.kind, "skip")
})

test("shell progress is not a completion unless progress was asked for", async () => {
  const progress = completion({ reason: BackgroundTaskCompletionReason.TASK_PROGRESS })
  const { handler } = createHandler<BackgroundTaskCompletionActionHandler>(BackgroundTaskCompletionActionHandler)
  const withoutProgress = await handler.prepareFollowupTurn(
    createContext(),
    completionAction([progress]),
    createPromptExecutor(),
    createStateHandler(),
    [],
  )
  assert.equal(withoutProgress.kind, "skip")

  // With progress reporting on, the same completion becomes a follow-up turn.
  const { handler: withProgress, updates } = createHandler<BackgroundTaskCompletionActionHandler>(
    BackgroundTaskCompletionActionHandler,
    { featureFlags: { enableBackgroundTaskProgress: true } },
  )
  const followup = await withProgress.prepareFollowupTurn(
    createContext(),
    completionAction([progress]),
    createPromptExecutor(),
    createStateHandler(),
    [],
  )
  assert.equal(followup.kind, "ready")
  // The user sees the completion as a message, since nobody else would tell them about it.
  assert.equal(updates.length, 1)
})

// ---------------------------------------------------------------------------------------------
// A user message
// ---------------------------------------------------------------------------------------------

test("a user message action without a message is refused", async () => {
  const { handler } = createHandler<UserMessageActionHandler>(UserMessageActionHandler)
  await assert.rejects(
    () => handler.initializeConversation(createContext(), {
      action: {},
      rootPromptExecutor: createPromptExecutor(),
      stateHandler: createStateHandler(),
      mcpTools: [],
    }),
    /User message is required/,
  )
})
