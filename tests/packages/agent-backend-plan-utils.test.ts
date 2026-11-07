import { test } from "node:test"
import assert from "node:assert/strict"

import {
  buildTodoStatusMap,
  getLatestPlanRegistryEntry,
  planFrontmatterSchema,
  planPhaseFrontmatterSchema,
  planTodoFrontmatterSchema,
  stringifyPlanFrontmatter,
  syncLatestPlanTodosToFile,
  updateTodoStatusArray,
} from "../../source/packages/agent/tools/core/create-plan/backend-plan-utils.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { PlanRegistryEntry } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { WriteResult, WriteSuccess } from "../../source/adapters/interop/proto/generated/agent/v1/write_exec_pb.ts"
import { readExecutorResource, type ReadExecutorResult } from "../../source/packages/agent-exec/read-operation.ts"
import { writeExecutorResource } from "../../source/packages/agent-exec/write-operation.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"

// ---------------------------------------------------------------------------------------------
// the frontmatter a plan carries
// ---------------------------------------------------------------------------------------------

test("frontmatter is written above the content, with a newline to close it", () => {
  const written = stringifyPlanFrontmatter("the plan body", { todos: [{ id: "1", status: "pending" }] })
  // The YAML writer quotes a numeric-looking id, since a string is what the schema asks for.
  assert.match(written, /^---\ntodos:\n {2}- id: '1'\n {4}status: pending\n---\nthe plan body\n$/)
})

test("content that already ends in a newline is not given another", () => {
  const written = stringifyPlanFrontmatter("the plan body\n", { todos: [] })
  assert.equal(written.endsWith("the plan body\n"), true)
  assert.equal(written.includes("the plan body\n\n"), false)
})

test("empty frontmatter is left out rather than written as a pair of markers", () => {
  assert.equal(stringifyPlanFrontmatter("the plan body", {}), "the plan body\n")
})

test("the frontmatter schemas accept what a plan may carry and pass the rest through", () => {
  assert.equal(planTodoFrontmatterSchema.safeParse({ id: "1", status: "pending", extra: true }).success, true)
  assert.equal(planTodoFrontmatterSchema.safeParse({ status: "pending" }).success, false)
  assert.equal(planPhaseFrontmatterSchema.safeParse({ name: "phase one", todos: [] }).success, true)
  assert.equal(planFrontmatterSchema.safeParse({ todos: [], phases: [], name: "the plan" }).success, true)
  assert.equal(planFrontmatterSchema.safeParse("not an object").success, false)
})

// ---------------------------------------------------------------------------------------------
// the plan the conversation is working from
// ---------------------------------------------------------------------------------------------

test("the latest plan is the last one the registry holds", () => {
  const first = new PlanRegistryEntry({ id: "plan-1", path: "/repo/plan-1.md" })
  const second = new PlanRegistryEntry({ id: "plan-2", path: "/repo/plan-2.md" })
  const registry = { plans: new Map([["plan-1", first], ["plan-2", second]]) }
  assert.equal(getLatestPlanRegistryEntry(registry), second)
  assert.equal(getLatestPlanRegistryEntry({ plans: new Map() }), undefined)
})

// ---------------------------------------------------------------------------------------------
// the todo statuses the conversation knows
// ---------------------------------------------------------------------------------------------

test("the statuses are read from the conversation's own todo list", async () => {
  const statuses = await buildTodoStatusMap([
    { id: "1", status: "pending" },
    { id: "2", status: "in_progress" },
  ])
  assert.equal(statuses.size, 2)
  assert.equal(statuses.get("1"), "pending")
  assert.equal(statuses.get("2"), "in_progress")
})

test("a conversation with no todos yields no statuses", async () => {
  assert.equal((await buildTodoStatusMap([])).size, 0)
})

test("a todo whose status changed is updated in place", () => {
  const { didUpdate, updatedTodos } = updateTodoStatusArray(
    [{ id: "1", status: "pending", title: "the first" }, { id: "2", status: "pending" }],
    new Map([["1", "completed"]]),
  )
  assert.equal(didUpdate, true)
  assert.deepEqual(updatedTodos[0], { id: "1", status: "completed", title: "the first" })
  // The todo the conversation does not know about is left as it was.
  assert.deepEqual(updatedTodos[1], { id: "2", status: "pending" })
})

test("nothing is updated when nothing changed", () => {
  const todos = [{ id: "1", status: "pending" }]
  assert.deepEqual(updateTodoStatusArray(todos, new Map([["1", "pending"]])), { didUpdate: false, updatedTodos: todos })
  assert.deepEqual(updateTodoStatusArray(todos, new Map()), { didUpdate: false, updatedTodos: todos })
})

test("a todo entry that is not a todo is left alone", () => {
  const { didUpdate, updatedTodos } = updateTodoStatusArray([{ title: "no id" }], new Map([["1", "completed"]]))
  assert.equal(didUpdate, false)
  assert.deepEqual(updatedTodos, [{ title: "no id" }])
})

// ---------------------------------------------------------------------------------------------
// syncing the file
// ---------------------------------------------------------------------------------------------

interface SyncHarness {
  readonly writes: Array<{ path: string; text?: string }>
  readonly reads: string[]
  readonly accessor: unknown
}

function syncHarness(options: {
  planContent?: string
  readFails?: boolean
  readBinary?: boolean
} = {}): SyncHarness {
  const writes: SyncHarness["writes"] = []
  const reads: string[] = []
  const accessor = {
    get: (resource: unknown) => {
      if (resource === readExecutorResource) {
        return {
          async execute(_ctx: Context, args: { path: string }) {
            reads.push(args.path)
            if (options.readFails === true) return { kind: "not-found", path: args.path } satisfies ReadExecutorResult
            const content = options.planContent ?? ""
            return {
              kind: "success",
              path: args.path,
              totalLines: content.split("\n").length,
              fileSize: BigInt(content.length),
              truncated: false,
              rangeApplied: false,
              output: options.readBinary === true
                ? { kind: "data", bytes: new Uint8Array([1, 2, 3]) }
                : { kind: "text", text: content },
            } satisfies ReadExecutorResult
          },
        }
      }
      return {
        async execute(_ctx: Context, args: { path: string; fileText?: string }) {
          writes.push({ path: args.path, ...(args.fileText === undefined ? {} : { text: args.fileText }) })
          return new WriteResult({ result: { case: "success", value: new WriteSuccess({ path: args.path }) } })
        },
      }
    },
  }
  return { writes, reads, accessor }
}

const planWith = (frontmatter: string): string => `---\n${frontmatter}\n---\nthe plan body\n`

function sync(
  harnessed: SyncHarness,
  options: {
    /** A session with no plan at all is asked for with null, since leaving it out means the usual path. */
    planPath?: string | null
    todos?: Array<{ id: string; status: "pending" | "in_progress" | "completed" | "cancelled" | "unspecified" }>
    mode?: SlateMode
  } = {},
) {
  const planPath = options.planPath === null ? undefined : options.planPath ?? "/repo/plan.md"
  const todos = (options.todos ?? [{ id: "1", status: "in_progress" }]).map(todo => ({
    ...todo,
    content: "task " + todo.id,
    createdAt: 1n,
    updatedAt: 1n,
  }))
  return syncLatestPlanTodosToFile({
    ctx: createContext(),
    resourceAccessor: harnessed.accessor as never,
    toolCallId: "call-1",
    todos,
    stateHandler: {
      mode: options.mode ?? SlateMode.AGENT,
      plans: planPath === undefined ? new Map() : new Map([["plan-1", new PlanRegistryEntry({ id: "plan-1", path: planPath })]]),
      recordFileState() {},
    } as never,
  })
}

test("a plan file's todo statuses are brought up to date", async () => {
  const harnessed = syncHarness({ planContent: planWith('todos:\n  - id: "1"\n    status: pending') })
  await sync(harnessed)
  assert.deepEqual(harnessed.reads, ["/repo/plan.md"])
  assert.equal(harnessed.writes.length, 1)
  assert.match(harnessed.writes[0]?.text ?? "", /status: in_progress/)
  assert.match(harnessed.writes[0]?.text ?? "", /the plan body/)
})

test("a todo inside a phase is updated as well", async () => {
  const harnessed = syncHarness({
    planContent: planWith('phases:\n  - name: "one"\n    todos:\n      - id: "1"\n        status: pending'),
  })
  await sync(harnessed)
  assert.match(harnessed.writes[0]?.text ?? "", /status: in_progress/)
})

test("a plan whose statuses already match is not written again", async () => {
  const harnessed = syncHarness({ planContent: planWith('todos:\n  - id: "1"\n    status: in_progress') })
  await sync(harnessed)
  assert.deepEqual(harnessed.writes, [])
})

test("a conversation with no plan file to sync does nothing", async () => {
  const harnessed = syncHarness({ planContent: planWith('todos:\n  - id: "1"\n    status: pending') })
  await sync(harnessed, { planPath: null })
  assert.deepEqual(harnessed.reads, [])
  assert.deepEqual(harnessed.writes, [])
})

test("a conversation with no todos has nothing to sync", async () => {
  const harnessed = syncHarness({ planContent: planWith('todos:\n  - id: "1"\n    status: pending') })
  await sync(harnessed, { todos: [] })
  assert.deepEqual(harnessed.reads, [])
})

test("a plan file that is gone is left alone rather than recreated", async () => {
  const harnessed = syncHarness({ readFails: true })
  await sync(harnessed)
  assert.deepEqual(harnessed.writes, [])
})

test("a plan file that is not text is left alone", async () => {
  const harnessed = syncHarness({ readBinary: true })
  await sync(harnessed)
  assert.deepEqual(harnessed.writes, [])
})

test("a plan with no todos of its own is left alone", async () => {
  const harnessed = syncHarness({ planContent: planWith('name: "a plan with no todos"') })
  await sync(harnessed)
  assert.deepEqual(harnessed.writes, [])
})

test("a plan whose frontmatter is not an object is left alone", async () => {
  const harnessed = syncHarness({ planContent: "---\njust a string\n---\nthe plan body\n" })
  await sync(harnessed)
  assert.deepEqual(harnessed.writes, [])
})

test("the write goes through the same path as any other edit", async () => {
  const harnessed = syncHarness({ planContent: planWith('todos:\n  - id: "1"\n    status: pending') })
  const writes: string[] = []
  const accessor = {
    get: (resource: unknown) => (resource === readExecutorResource
      ? (harnessed.accessor as { get(resource: unknown): unknown }).get(resource)
      : {
        async execute(_ctx: Context, args: { path: string; fileText?: string }, options: { execId?: string }) {
          writes.push(args.path)
          assert.notEqual(options?.execId, undefined)
          return new WriteResult({ result: { case: "success", value: new WriteSuccess({ path: args.path }) } })
        },
      }),
  }
  await syncLatestPlanTodosToFile({
    ctx: createContext(),
    resourceAccessor: accessor as never,
    toolCallId: "call-1",
    todos: [{ id: "1", content: "task 1", status: "in_progress", createdAt: 1n, updatedAt: 1n }],
    stateHandler: {
      mode: SlateMode.AGENT,
      plans: new Map([["plan-1", new PlanRegistryEntry({ id: "plan-1", path: "/repo/plan.md" })]]),
      recordFileState() {},
    } as never,
  })
  assert.deepEqual(writes, ["/repo/plan.md"])
})
