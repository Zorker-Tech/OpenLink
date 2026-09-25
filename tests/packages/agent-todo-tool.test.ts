import { test } from "node:test"
import assert from "node:assert/strict"

import { createUpdateTodosTool, type UpdateTodosStateHandler } from "../../source/packages/agent/tools/core/todo/todo.ts"
import { ToolCallArgParseError } from "../../source/packages/agent/tools/tool-support.ts"
import { createContext } from "../../source/packages/context/context.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { fromRedactedTodoItem, toRedactedTodoItem } from "../../source/packages/redacted-protos/generated/agent/v1/todo_tool_redacted.ts"
import { AgentMode, PlanRegistryEntry, ToolCall } from "../../source/packages/proto/generated/agent/v1/agent_pb.ts"
import { TodoItem, TodoStatus, UpdateTodosResult, UpdateTodosToolCall } from "../../source/packages/proto/generated/agent/v1/todo_tool_pb.ts"
import { readExecutorResource } from "../../source/packages/agent-exec/read-operation.ts"
import { ReadResult, ReadSuccess } from "../../source/packages/proto/generated/agent/v1/read_exec_pb.ts"
import { WriteResult, WriteSuccess } from "../../source/packages/proto/generated/agent/v1/write_exec_pb.ts"
import type { TextResult } from "../../source/packages/chat-inference/prompt-executor.ts"

// ---------------------------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------------------------

type RedactedTodo = Parameters<typeof fromRedactedTodoItem>[0]
type Tool = ReturnType<typeof createUpdateTodosTool>

const PLAN_FRONTMATTER = 'todos:\n  - id: "1"\n    status: pending'

function harness(options: { todos?: TodoItem[]; planPath?: string; planContent?: string } = {}) {
  let stored: RedactedTodo[] = (options.todos ?? []).map(todo => toRedactedTodoItem(todo, PrivacyMode.NO_STORAGE))
  const reads: Array<{ path: string; toolCallId?: string }> = []
  const writes: Array<{ path: string; text?: string }> = []
  const accessor = {
    get: (resource: unknown) => resource === readExecutorResource
      ? {
        async execute(_ctx: unknown, args: { path: string; toolCallId?: string }) {
          reads.push({ path: args.path, ...(args.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }) })
          const content = options.planContent ?? ""
          return new ReadResult({
            result: {
              case: "success",
              value: new ReadSuccess({
                path: args.path,
                totalLines: content.split("\n").length,
                fileSize: BigInt(content.length),
                output: { case: "content", value: content },
              }),
            },
          })
        },
      }
      : {
        async execute(_ctx: unknown, args: { path: string; fileText?: string }) {
          writes.push({ path: args.path, ...(args.fileText === undefined ? {} : { text: args.fileText }) })
          return new WriteResult({ result: { case: "success", value: new WriteSuccess({ path: args.path }) } })
        },
      },
  }
  const stateHandler = {
    // The list is read afresh on every call, so the refs always see what the last call stored.
    get todos() { return stored.map(item => ({ get: async () => item })) },
    getPrivacyMode: () => PrivacyMode.NO_STORAGE,
    setTodos(next: readonly unknown[]) { stored = next as RedactedTodo[] },
    mode: AgentMode.AGENT,
    plans: options.planPath === undefined
      ? new Map()
      : new Map([["plan-1", new PlanRegistryEntry({ id: "plan-1", path: options.planPath })]]),
    recordFileState() {},
  }
  return {
    accessor,
    reads,
    writes,
    /** The stored list as plain items, which is what a caller of the tool would see. */
    list: () => stored.map(item => fromRedactedTodoItem(item, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined)),
    build: (promptVersion?: string) => createUpdateTodosTool(
      accessor as never,
      stateHandler as unknown as UpdateTodosStateHandler,
      ...(promptVersion === undefined ? [] : [promptVersion] as [string]),
    ),
  }
}

function interaction() {
  const partials: ToolCall[] = []
  const calls: ToolCall[] = []
  return {
    partials,
    calls,
    handler: {
      emitPartialToolCall(_ctx: unknown, _toolCallId: string, toolCall: ToolCall) { partials.push(toolCall) },
      async executeToolCall(ctx: unknown, toolCall: ToolCall, _toolCallId: string, run: (ctx: unknown) => Promise<unknown>) {
        calls.push(toolCall)
        return await run(ctx)
      },
    },
  }
}

/** Runs the tool's own execute, which is where the argument stream is parsed and the list is written. */
async function run(
  tool: Tool,
  harnessed: ReturnType<typeof harness>,
  recording: ReturnType<typeof interaction>,
  args: string,
  chunks?: readonly string[],
): Promise<UpdateTodosResult> {
  const stream = (async function* () { for (const chunk of chunks ?? [args]) yield chunk })()
  const execute = tool.execute as (ctx: unknown, handler: unknown, stream: AsyncIterable<string>, meta: unknown) => Promise<UpdateTodosResult>
  return await execute(createContext(), recording.handler, stream, { toolCallId: "call-1" })
}

const todoCall = (call: ToolCall): UpdateTodosToolCall => {
  assert.equal(call.tool.case, "updateTodosToolCall")
  return call.tool.value
}

const successOf = (result: UpdateTodosResult) => {
  assert.equal(result.result.case, "success")
  return (result.result as { value: { todos: readonly TodoItem[]; totalCount: number; wasMerge: boolean } }).value
}

// ---------------------------------------------------------------------------------------------
// the name and the text the model reads
// ---------------------------------------------------------------------------------------------

test("the tool is named what the prompt version was trained on", () => {
  const harnessed = harness()
  assert.equal(harnessed.build("dsv3-1018").name, "todo_write")
  for (const version of ["latest", "cursor-0226", "dsv3-1205", "gpt5-codex", "codex-cloud", "haiku"]) {
    assert.equal(harnessed.build(version).name, "TodoWrite", version)
  }
  assert.throws(() => harnessed.build("a-version-nobody-trained"), /Unhandled version/)
})

test("the description is the one that version was trained on", () => {
  const descriptionOf = (version: string) => (harness().build(version).descriptionGenerator as () => string)()
  assert.equal(descriptionOf("cursor-0226"), "Use this tool to create and manage a structured task list for your current coding session.")
  assert.match(descriptionOf("latest"), /### When to Use This Tool/)
  assert.match(descriptionOf("latest"), /don't tell the user you're updating todos/)
  assert.match(descriptionOf("gpt5-codex"), /### Guidelines/)
  // The codex wording is a different prompt, not a variant of the same one.
  assert.equal(/### Guidelines/.test(descriptionOf("latest")), false)
})

// ---------------------------------------------------------------------------------------------
// merging
// ---------------------------------------------------------------------------------------------

test("a merge updates the items the model named and keeps everything else", async () => {
  const harnessed = harness({
    todos: [
      new TodoItem({ id: "1", content: "the first", status: TodoStatus.PENDING, createdAt: 1_000n, updatedAt: 1_000n }),
      new TodoItem({ id: "2", content: "the second", status: TodoStatus.COMPLETED, createdAt: 2_000n, updatedAt: 2_000n }),
    ],
  })
  const recording = interaction()
  const result = await run(harnessed.build(), harnessed, recording, JSON.stringify({
    merge: true,
    todos: [
      { id: "1", status: "completed" },
      { id: "3", content: "the third", status: "pending" },
    ],
  }))
  const success = successOf(result)
  assert.equal(success.wasMerge, true)
  assert.equal(success.totalCount, 3)
  const list = harnessed.list()
  assert.deepEqual(list.map(todo => todo.id), ["1", "2", "3"])
  // An item the model did not restate keeps its text, and one it did not mention is left untouched.
  assert.equal(list[0]?.content, "the first")
  assert.equal(list[0]?.status, TodoStatus.COMPLETED)
  assert.equal(list[0]?.createdAt, 1_000n)
  assert.equal(list[1]?.content, "the second")
  assert.equal(list[2]?.content, "the third")
})

test("a merge that names a new item without text is refused", async () => {
  const harnessed = harness()
  const recording = interaction()
  await assert.rejects(
    () => run(harnessed.build(), harnessed, recording, JSON.stringify({ merge: true, todos: [{ id: "9", status: "pending" }] })),
    (error: unknown) => {
      assert.equal(error instanceof ToolCallArgParseError, true)
      assert.match((error as Error).message, /must provide 'content' for new todos items/)
      return true
    },
  )
  assert.deepEqual(harnessed.list(), [])
})

test("an item with no text at all is refused as well", async () => {
  const harnessed = harness()
  await assert.rejects(
    () => run(harnessed.build(), harnessed, interaction(), JSON.stringify({ merge: true, todos: [{ id: "9", content: "", status: "pending" }] })),
    /must provide 'content' for new todos items/,
  )
})

test("a call that omits the merge flag means to merge", async () => {
  const harnessed = harness({ todos: [new TodoItem({ id: "1", content: "kept", status: TodoStatus.PENDING })] })
  const result = await run(harnessed.build(), harnessed, interaction(), JSON.stringify({ todos: [{ id: "1", status: "in_progress" }] }))
  assert.equal(successOf(result).wasMerge, true)
  assert.equal(harnessed.list()[0]?.content, "kept")
  assert.equal(harnessed.list()[0]?.status, TodoStatus.IN_PROGRESS)
})

test("the model is told when a list has nothing in progress", async () => {
  const harnessed = harness()
  const result = await run(harnessed.build(), harnessed, interaction(), JSON.stringify({
    merge: true,
    todos: [{ id: "1", content: "waiting", status: "pending" }],
  }))
  const rendered = await (harnessed.build().render as (ctx: unknown, value: UpdateTodosResult) => Promise<TextResult>)(createContext(), result)
  assert.match(rendered.content[0]?.text ?? "", /Successfully updated TODOs/)
  assert.match(rendered.content[0]?.text ?? "", /No TODOs are marked in-progress/)
})

// ---------------------------------------------------------------------------------------------
// replacing
// ---------------------------------------------------------------------------------------------

test("a replacement becomes the whole list", async () => {
  const harnessed = harness({ todos: [new TodoItem({ id: "1", content: "old", status: TodoStatus.PENDING })] })
  const result = await run(harnessed.build(), harnessed, interaction(), JSON.stringify({
    merge: false,
    todos: [
      { id: "7", content: "the seventh", status: "in_progress" },
      { id: "8", content: "the eighth", status: "pending" },
    ],
  }))
  const success = successOf(result)
  assert.equal(success.wasMerge, false)
  assert.equal(success.totalCount, 2)
  assert.deepEqual(harnessed.list().map(todo => todo.id), ["7", "8"])
})

test("an item that survives a replacement keeps when it was created", async () => {
  const harnessed = harness({
    todos: [new TodoItem({ id: "1", content: "the first", status: TodoStatus.PENDING, createdAt: 1_000n, updatedAt: 1_000n })],
  })
  await run(harnessed.build(), harnessed, interaction(), JSON.stringify({
    merge: false,
    todos: [{ id: "1", content: "rewritten", status: "completed" }],
  }))
  const list = harnessed.list()
  assert.equal(list[0]?.content, "rewritten")
  assert.equal(list[0]?.createdAt, 1_000n)
  assert.notEqual(list[0]?.updatedAt, 1_000n)
})

test("a replacement the parser can read only as text is still read", async () => {
  const harnessed = harness()
  // The list arrives as a string of JSON, which one provider does when it quotes the argument.
  const args = JSON.stringify({ merge: false, todos: JSON.stringify([{ id: "1", content: "one", status: "pending" }]) })
  const result = await run(harnessed.build(), harnessed, interaction(), args)
  assert.equal(successOf(result).totalCount, 1)
})

test("arguments that are not JSON are refused as a tool call", async () => {
  const harnessed = harness()
  await assert.rejects(
    () => run(harnessed.build(), harnessed, interaction(), "{not json"),
    (error: unknown) => {
      assert.equal(error instanceof ToolCallArgParseError, true)
      return true
    },
  )
})

// ---------------------------------------------------------------------------------------------
// what the user sees while the list is written
// ---------------------------------------------------------------------------------------------

test("the list is shown item by item as the model writes it", async () => {
  const harnessed = harness()
  const recording = interaction()
  const result = await run(harnessed.build(), harnessed, recording, "", [
    '{"todos":[{"id":"1","content":"the first","status":"pending"},',
    '{"id":"2","content":"the second","status":"in_progress"}],"merge":true}',
  ])
  assert.equal(successOf(result).totalCount, 2)
  // The first thing shown is the call itself, before any item has been written.
  assert.equal(todoCall(recording.partials[0] as ToolCall).args, undefined)
  const shown = recording.partials.slice(1).map(call => todoCall(call).args?.todos.map(todo => todo.id))
  assert.deepEqual(shown, [["1"], ["1", "2"]])
  // The call that is recorded as executed carries the whole list.
  assert.deepEqual(todoCall(recording.calls[0] as ToolCall).args?.todos.map(todo => todo.id), ["1", "2"])
})

// ---------------------------------------------------------------------------------------------
// the plan file
// ---------------------------------------------------------------------------------------------

test("the plan file the session is working from is brought up to date", async () => {
  const harnessed = harness({
    todos: [new TodoItem({ id: "1", content: "the first", status: TodoStatus.PENDING })],
    planPath: "/repo/plan.md",
    planContent: `---\n${PLAN_FRONTMATTER}\n---\nthe plan body\n`,
  })
  await run(harnessed.build(), harnessed, interaction(), JSON.stringify({
    merge: true,
    todos: [{ id: "1", status: "in_progress" }],
  }))
  assert.deepEqual(harnessed.reads, [{ path: "/repo/plan.md", toolCallId: "call-1" }])
  assert.equal(harnessed.writes.length, 1)
  assert.match(harnessed.writes[0]?.text ?? "", /status: in_progress/)
  assert.match(harnessed.writes[0]?.text ?? "", /the plan body/)
})

test("a session with no plan file writes nothing", async () => {
  const harnessed = harness({ todos: [new TodoItem({ id: "1", content: "the first", status: TodoStatus.PENDING })] })
  await run(harnessed.build(), harnessed, interaction(), JSON.stringify({ merge: true, todos: [{ id: "1", status: "completed" }] }))
  assert.deepEqual(harnessed.reads, [])
  assert.deepEqual(harnessed.writes, [])
})

// ---------------------------------------------------------------------------------------------
// failures
// ---------------------------------------------------------------------------------------------

test("an error is rendered as the text the model reads", async () => {
  const tool = harness().build()
  const render = tool.render as (ctx: unknown, value: UpdateTodosResult) => Promise<TextResult>
  const failure = new UpdateTodosResult({ result: { case: "error", value: { error: "the list was refused" } } as never })
  assert.equal((await render(createContext(), failure)).content[0]?.text, "the list was refused")
  assert.equal((await render(createContext(), new UpdateTodosResult())).content[0]?.text, "Unknown error")
})

test("a thrown failure is serialized into the call's own error result", () => {
  const serialized = (harness().build().serializeError as (error: unknown) => ToolCall)(new Error("the write failed"))
  const value = todoCall(serialized)
  assert.equal(value.result?.result?.case, "error")
  assert.equal((value.result?.result as { value: { error: string } }).value.error, "the write failed")
})

test("a failure that is not an error still carries its message", () => {
  const serialized = (harness().build().serializeError as (error: unknown) => ToolCall)("just a string")
  const value = todoCall(serialized)
  assert.equal((value.result?.result as { value: { error: string } }).value.error, "just a string")
})
