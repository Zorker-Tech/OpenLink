import { test } from "node:test"
import assert from "node:assert/strict"

import { createTaskTool } from "../../source/packages/agent/tools/task.ts"
import { createContext } from "../../source/packages/context/context.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { createSubagentModels } from "../../source/packages/agent/tools/core/subagent/models.ts"
import { SubagentType, SubagentTypeExplore, SubagentTypeUnspecified } from "../../source/packages/proto/generated/agent/v1/subagents_pb.ts"
import { SubagentBackgroundReason, TaskResult, TaskSuccess } from "../../source/packages/proto/generated/agent/v1/agent_pb.ts"

// The task tool hands work to a subagent. Building one needs a configuration, a parent state and the
// subagent configs it may offer; the assertions below are about what the tool looks like to the model and
// what it refuses before anything runs.

type Tool = {
  readonly name: string
  readonly descriptionGenerator: (props: Record<string, unknown>, options: Record<string, unknown>) => string
  readonly execute: (
    ctx: unknown,
    handler: unknown,
    args: AsyncIterable<string>,
    meta: { readonly toolCallId: string },
  ) => Promise<unknown>
}

function createTool(options: Record<string, unknown> = {}, parentModelInfo: Record<string, unknown> = { promptVersion: "latest" }) {
  return createTaskTool(
    {} as never,
    async () => ({ agentConfig: {}, promptSession: {}, summarizationHandler: {} }) as never,
    parentModelInfo as never,
    {
      turns: [],
      getBlobStore: () => ({}),
      getPrivacyMode: () => PrivacyMode.UNSPECIFIED,
      persistSubagentState: () => {},
      computeNewStructure: async () => ({}),
      restoreSubagentState: () => undefined,
      resolveSubagentId: () => undefined,
      getSubagentIdToResume: () => undefined,
    } as never,
    [],
    { subagentModels: { modelsBySlug: new Map() }, ...options } as never,
  ) as unknown as Tool
}

async function* argsStream(args: unknown) {
  yield JSON.stringify(args)
}

/** The subagent types a configured tool offers. */
const subagentConfigs = [
  { subagent_type: new SubagentType({ type: { case: "unspecified", value: new SubagentTypeUnspecified({}) } }) },
  { subagent_type: new SubagentType({ type: { case: "explore", value: new SubagentTypeExplore({}) } }), description: "Search the codebase." },
]
const subagentModelCatalog = createSubagentModels({ standard: { slug: "standard-model" }, fast: { slug: "fast-model" } })

/** A tool that offers the configured subagents, so its schema and its launch decisions are the real ones. */
function createConfiguredTool(options: Record<string, unknown> = {}, parentModelInfo: Record<string, unknown> = { promptVersion: "latest" }) {
  return createTaskTool(
    {} as never,
    async () => ({ agentConfig: {}, promptSession: {}, summarizationHandler: {} }) as never,
    parentModelInfo as never,
    {
      turns: [],
      getBlobStore: () => ({}),
      getPrivacyMode: () => PrivacyMode.UNSPECIFIED,
      persistSubagentState: () => {},
      computeNewStructure: async () => ({}),
      restoreSubagentState: () => undefined,
      resolveSubagentId: () => undefined,
      getSubagentIdToResume: () => undefined,
    } as never,
    subagentConfigs as never,
    { subagentModels: subagentModelCatalog, ...options } as never,
  ) as unknown as Tool & {
    readonly toolIdentifier: string
    readonly parameters: unknown
    readonly render: (ctx: unknown, result: TaskResult, props?: unknown) => Promise<{ isError?: boolean; content?: readonly { text?: string }[] }>
    readonly serializeError: (error: unknown) => { toJson: () => unknown }
    readonly prepareSubagent: (ctx: unknown, rawArgs: unknown, meta: { toolCallId: string }) => Promise<unknown>
  }
}

test("the tool is named for the model family that reads it", () => {
  assert.equal(createTool().name, "Task")
  // A codex prompt version calls it something else, and a composer model calls it something else again.
  assert.equal(createTool({}, { promptVersion: "gpt5-codex" }).name, "Subagent")
  assert.equal(createTool({}, { promptVersion: "latest", isComposer1: true }).name, "mcp_task")
})

test("a description that was built for a placement is not built again", () => {
  const tool = createTool()
  // Reading the tool names is what building the description costs; a cached description does not read them.
  let reads = 0
  const props = {
    get allTools() {
      reads += 1
      return {}
    },
  }
  const first = tool.descriptionGenerator(props, { promptVisible: true })
  assert.equal(typeof first, "string")
  assert.equal(first.length > 0, true)
  assert.equal(reads > 0, true)
  // The second call for the same placement comes back from the cache and reads nothing.
  reads = 0
  assert.equal(tool.descriptionGenerator(props, { promptVisible: true }), first)
  assert.equal(reads, 0)
})

test("a catalogue that lives in the user info is pointed at rather than repeated", () => {
  const props = { allTools: {} }
  // With no models to list, the tool says so where the catalogue belongs to it...
  const inTool = createTool().descriptionGenerator(props, { promptVisible: true })
  assert.match(inTool, /No alternative models are available/)
  // ...and says where the catalogue is instead, when it belongs to the user info.
  const inUserInfo = createTool({ subagentModelsInUserInfo: true }).descriptionGenerator(props, { promptVisible: true })
  assert.doesNotMatch(inUserInfo, /No alternative models are available/)
  assert.match(inUserInfo, /initial user-info message/)
})

test("arguments that name no subagent the tool offers are refused", async () => {
  const tool = createTool()
  await assert.rejects(
    () => tool.execute(createContext(), { emitPartialToolCall: () => {} }, argsStream({ subagent_type: "nobody" }), { toolCallId: "call-1" }),
    /Invalid arguments/,
  )
})

test("arguments that are not JSON are refused before anything is resolved", async () => {
  const tool = createTool()
  await assert.rejects(
    () => tool.execute(createContext(), { emitPartialToolCall: () => {} }, argsStream("not an object"), { toolCallId: "call-1" }),
    /Invalid arguments/,
  )
})

test("the schema and the description follow how the subagent is launched", () => {
  const parameters = (options: Record<string, unknown>) => JSON.stringify(createConfiguredTool(options).parameters)
  // A client-side or cloud launch may run in the background; a server-side one may not.
  assert.equal(parameters({ useClientSideSubagent: true }).includes("run_in_background"), true)
  assert.equal(parameters({ enableCloudAsyncSubagents: true }).includes("run_in_background"), true)
  assert.equal(parameters({}).includes("run_in_background"), false)
  assert.equal(parameters({ useClientSideSubagent: true, requireServerSideSubagent: true }).includes("run_in_background"), false)
  // Interrupts, background defaults and resume-self are only offered when their launch asks for them.
  assert.notEqual(parameters({ useClientSideSubagent: true, enableSubagentInterrupt: true }), parameters({ useClientSideSubagent: true }))
  assert.notEqual(parameters({ useClientSideSubagent: true, defaultSubagentsRunInBackground: true }), parameters({ useClientSideSubagent: true }))
  // A background default means nothing when the launch cannot run in the background at all.
  assert.equal(parameters({ defaultSubagentsRunInBackground: true }), parameters({}))
  assert.equal(parameters({ useClientSideSubagent: true, requireServerSideSubagent: true, defaultSubagentsRunInBackground: true }), parameters({ useClientSideSubagent: true, requireServerSideSubagent: true }))
  assert.notEqual(parameters({ useClientSideSubagent: true, allowResumeSelfFork: true }), parameters({ useClientSideSubagent: true }))
  const description = (options: Record<string, unknown>) => createConfiguredTool(options).descriptionGenerator({ allTools: {} }, { promptVisible: true })
  assert.notEqual(description({ enableCloudAsyncSubagents: true, allowResumeSelfFork: true }), description({ enableCloudAsyncSubagents: true }))
  assert.notEqual(description({ useClientSideSubagent: true, enableAgentChatLinks: true }), description({ useClientSideSubagent: true }))
})

test("a description is cached per placement and rebuilt for another one", () => {
  const tool = createConfiguredTool()
  let reads = 0
  const props = {
    get allTools() {
      reads += 1
      return {}
    },
  }
  const inTool = tool.descriptionGenerator(props, { promptVisible: true })
  assert.equal(reads > 0, true)
  const readsAfterFirst = reads
  // The same placement is remembered, so the tool names are not read again.
  assert.equal(tool.descriptionGenerator(props, { promptVisible: true }), inTool)
  assert.equal(reads, readsAfterFirst)
  // The other placement is a different description, and it is built.
  const inUserInfo = tool.descriptionGenerator(props, { promptVisible: false })
  assert.notEqual(inUserInfo, inTool)
  assert.equal(reads > readsAfterFirst, true)
})

test("arguments are refused with the reason they were refused", async () => {
  const tool = createConfiguredTool()
  await assert.rejects(
    () => tool.prepareSubagent(createContext(), "not json", { toolCallId: "call-1" }),
    (error: unknown) => (error as Error).message === "Invalid arguments:\nargument: Unexpected token 'o', \"not json\" is not valid JSON",
  )
  await assert.rejects(
    () => tool.prepareSubagent(createContext(), { prompt: "go", subagent_type: "nobody" }, { toolCallId: "call-1" }),
    (error: unknown) => (error as Error).message === "Invalid arguments:\nsubagent_type: Invalid value. Expected one of: generalPurpose, explore",
  )
  await assert.rejects(
    () => tool.prepareSubagent(createContext(), { prompt: "go", subagent_type: "generalPurpose", resume: "self" }, { toolCallId: "call-1" }),
    (error: unknown) => (error as Error).message === 'Invalid arguments:\nresume="self" is not available for this Task tool.',
  )
  // With resume-self allowed the refusal is not about resume at all.
  await assert.rejects(
    () => createConfiguredTool({ useClientSideSubagent: true, allowResumeSelfFork: true }).prepareSubagent(createContext(), { prompt: "go", subagent_type: "generalPurpose", resume: "self" }, { toolCallId: "call-1" }),
    (error: unknown) => error instanceof Error && error.message.includes('resume="self" is not available') === false,
  )
})

test("the tool names itself and its identifier", () => {
  const tool = createConfiguredTool()
  assert.equal(tool.toolIdentifier, "TASK")
  assert.equal(tool.name, "Task")
})

test("a task result renders into words, and a thrown error serializes into its message", async () => {
  const tool = createConfiguredTool()
  const success = new TaskResult({ result: { case: "success", value: new TaskSuccess({ agentId: "agent-1", isBackground: true }) } })
  const renderedSuccess = await tool.render(createContext(), success, undefined)
  assert.equal(renderedSuccess.isError, false)
  assert.match(String(renderedSuccess.content?.[0]?.text), /Agent ID: agent-1/)
  const failure = new TaskResult({ result: { case: "error", value: { error: "the subagent refused" } } })
  const renderedFailure = await tool.render(createContext(), failure, undefined)
  assert.equal(renderedFailure.isError, true)
  assert.equal(String(renderedFailure.content?.[0]?.text), "Error: the subagent refused")
  assert.deepEqual(tool.serializeError(new Error("boom")).toJson(), { taskToolCall: { result: { error: { error: "boom" } } } })
  assert.deepEqual(tool.serializeError("nope").toJson(), { taskToolCall: { result: { error: { error: "nope" } } } })
})

test("the notification hints change what a background result says", async () => {
  const result = new TaskResult({ result: { case: "success", value: new TaskSuccess({ agentId: "agent-1", isBackground: true, resultSuffix: "done", backgroundReason: SubagentBackgroundReason.AGENT_REQUEST, transcriptPath: "/tmp/subagent.jsonl" }) } })
  const withHints = await createConfiguredTool({ useClientSideSubagent: true, enableJobCompletionNotifications: true }).render(createContext(), result, undefined)
  const withoutHints = await createConfiguredTool({ useClientSideSubagent: true }).render(createContext(), result, undefined)
  assert.notEqual(String(withHints.content?.[0]?.text), String(withoutHints.content?.[0]?.text))
  const hiddenHints = await createConfiguredTool({ useClientSideSubagent: true, enableJobCompletionNotifications: true, hideAsyncSubagentTaskNotifications: true }).render(createContext(), result, undefined)
  assert.notEqual(String(hiddenHints.content?.[0]?.text), String(withHints.content?.[0]?.text))
})
