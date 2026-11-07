import { test } from "node:test"
import assert from "node:assert/strict"

import { createUpdateTodosTool, type UpdateTodosStateHandler } from "../../source/adapters/interop/agent/todo-tool-adapter.ts"
import { ToolCallArgParseError } from "../../source/packages/agent/tools/tool-support.ts"
import { createContext } from "../../source/packages/context/context.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { PlanRegistryEntry, ToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"
import { TodoItem, TodoStatus, UpdateTodosResult, UpdateTodosToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/todo_tool_pb.ts"
import { cloneSlateTodoItem, type SlateTodoItem } from "../../source/packages/agent/tools/core/todo/contracts.ts"
import { fromInteropTodoItem, toInteropTodoItem } from "../../source/adapters/interop/agent/todo-schema-adapter.ts"
import { readExecutorResource } from "../../source/packages/agent-exec/read-operation.ts"
import type { WriteExecutorResult } from "../../source/packages/agent-exec/write-operation.ts"
import type { TextResult } from "../../source/packages/chat-inference/prompt-executor.ts"

// ---------------------------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------------------------

type Tool = ReturnType<typeof createUpdateTodosTool>

const PLAN_FRONTMATTER = 'todos:\n  - id: "1"\n    status: pending'

function harness(options: { todos?: TodoItem[]; planPath?: string; planContent?: string } = {}) {
  let stored: SlateTodoItem[] = (options.todos ?? []).map(fromInteropTodoItem)
  const reads: Array<{ path: string; toolCallId?: string }> = []
  const writes: Array<{ path: string; text?: string }> = []
  const accessor = {
    get: (resource: unknown) => resource === readExecutorResource
      ? {
        async execute(_ctx: unknown, args: { path: string; toolCallId?: string }) {
          reads.push({ path: args.path, ...(args.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }) })
          const content = options.planContent ?? ""
          return {
            kind: "success",
            path: args.path,
            totalLines: content.split("\n").length,
            fileSize: BigInt(content.length),
            output: { kind: "text", text: content },
            truncated: false,
            rangeApplied: false,
          }
        },
      }
      : {
        async execute(_ctx: unknown, args: { path: string; text?: string }): Promise<WriteExecutorResult> {
          writes.push({ path: args.path, ...(args.text === undefined ? {} : { text: args.text }) })
          return { kind: "success", path: args.path, linesWritten: 0, bytesWritten: 0 }
        },
      },
  }
  const stateHandler = {
    // The list is read afresh on every call, so the refs always see what the last call stored.
    get todos() { return stored.map(item => ({ get: async () => item })) },
    getPrivacyMode: () => PrivacyMode.NO_STORAGE,
    setTodos(next: readonly SlateTodoItem[]) { stored = next.map(cloneSlateTodoItem) },
    mode: SlateMode.AGENT,
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
    list: () => stored.map(toInteropTodoItem),
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

test("the inference profile selects Slate-authored task guidance", () => {
  const descriptionOf = (version: string) => (harness().build(version).descriptionGenerator as () => string)()
  assert.match(descriptionOf("cursor-0226"), /session's task list/)
  assert.match(descriptionOf("latest"), /stable id/)
  assert.match(descriptionOf("gpt5-codex"), /independent work/)
  assert.notEqual(descriptionOf("gpt5-codex"), descriptionOf("latest"))
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
  assert.match(rendered.content[0]?.text ?? "", /Task list updated/)
  assert.match(rendered.content[0]?.text ?? "", /No task is marked in progress/)
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
  assert.equal((await render(createContext(), new UpdateTodosResult())).content[0]?.text, "No task update result was returned.")
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
