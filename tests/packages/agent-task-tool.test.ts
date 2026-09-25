import { test } from "node:test"
import assert from "node:assert/strict"

import { createTaskTool } from "../../source/packages/agent/tools/task.ts"
import { createContext } from "../../source/packages/context/context.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"

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
