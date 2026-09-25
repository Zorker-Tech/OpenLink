import { test } from "node:test"
import assert from "node:assert/strict"

import { TodoStatus, UpdateTodosSuccess } from "../../source/packages/proto/generated/agent/v1/todo_tool_pb.ts"
import {
  createSchemaTowardsModel,
  renderUpdateTodosSuccessMessage,
  todoToolSchemaForParsing,
} from "../../source/packages/agent/tools/core/todo/schema.ts"
import {
  getRequiredPermissionsSchema,
  hasNetworkAllowlist,
} from "../../source/packages/agent/tools/core/shell/sandbox-permissions.ts"

// ---------------------------------------------------------------------------------------------
// the todo schema the model is shown
// ---------------------------------------------------------------------------------------------

test("every prompt version gets a schema it was trained on", () => {
  const early = createSchemaTowardsModel("dsv3-1018")
  assert.deepEqual(Object.keys(early.shape), ["merge", "todos"])

  const later = createSchemaTowardsModel("dsv3-1205")
  assert.deepEqual(Object.keys(later.shape), ["todos", "merge"])

  const defaultOrder = createSchemaTowardsModel("something-else")
  assert.deepEqual(Object.keys(defaultOrder.shape), ["todos", "merge"])
  const mergeFirst = createSchemaTowardsModel("something-else", { mergeTodosFirst: true })
  assert.deepEqual(Object.keys(mergeFirst.shape), ["merge", "todos"])
})

test("the early version allows a merge that updates only a status", () => {
  const early = createSchemaTowardsModel("dsv3-1018")
  assert.equal(early.safeParse({ merge: true, todos: [{ id: "a", status: "in_progress" }] }).success, true)
  const later = createSchemaTowardsModel("dsv3-1205")
  assert.equal(later.safeParse({ merge: true, todos: [{ id: "a", status: "in_progress" }] }).success, false)
})

test("a minimum number of items is enforced only when asked for", () => {
  const withMin = createSchemaTowardsModel("x", { minTodos: 2 })
  assert.equal(withMin.safeParse({ merge: false, todos: [{ id: "a", content: "a", status: "pending" }] }).success, false)
  assert.equal(
    withMin.safeParse({ merge: false, todos: [{ id: "a", content: "a", status: "pending" }, { id: "b", content: "b", status: "pending" }] }).success,
    true,
  )
})

test("parsing assumes a merge when the model did not say", () => {
  const parsed = todoToolSchemaForParsing.parse({ todos: [{ id: "a", status: "pending" }] })
  assert.equal(parsed.merge, true)
})

test("parsing reads a lenient boolean for the merge flag", () => {
  assert.equal(todoToolSchemaForParsing.parse({ merge: "false", todos: [{ id: "a", content: "a", status: "pending" }] }).merge, false)
})

test("a merge may leave a content out, a replacement may not", () => {
  assert.equal(todoToolSchemaForParsing.safeParse({ merge: true, todos: [{ id: "a", status: "pending" }] }).success, true)
  assert.equal(todoToolSchemaForParsing.safeParse({ merge: false, todos: [{ id: "a", status: "pending" }] }).success, false)
})

test("a list sent as text is still read", () => {
  const parsed = todoToolSchemaForParsing.parse({ merge: true, todos: '[{"id":"a","status":"pending"}]' })
  assert.equal(parsed.todos.length, 1)
})

test("a value that is not an object at all is passed to the schema to refuse", () => {
  assert.equal(todoToolSchemaForParsing.safeParse("nope").success, false)
  assert.equal(todoToolSchemaForParsing.safeParse(null).success, false)
})

// ---------------------------------------------------------------------------------------------
// the message that comes back
// ---------------------------------------------------------------------------------------------

function success(todos: Array<{ id: string; content: string; status: TodoStatus }>, wasMerge?: boolean): UpdateTodosSuccess {
  return new UpdateTodosSuccess({
    todos: todos.map(todo => ({ ...todo, createdAt: 0n, updatedAt: 0n })),
    ...(wasMerge !== undefined ? { wasMerge } : {}),
  } as never)
}

test("the list comes back as lines, and a list with nothing in progress is called out", () => {
  const message = renderUpdateTodosSuccessMessage(success([
    { id: "a", content: "first", status: TodoStatus.PENDING },
  ]), "something-else")
  assert.match(message, /Successfully updated TODOs/)
  assert.match(message, /No TODOs are marked in-progress/)
  assert.match(message, /- \*\*PENDING\*\*: first \(id: a\)/)
})

test("a list with something in progress is not called out", () => {
  const message = renderUpdateTodosSuccessMessage(success([
    { id: "a", content: "first", status: TodoStatus.IN_PROGRESS },
  ]), "something-else")
  assert.doesNotMatch(message, /No TODOs are marked in-progress/)
})

test("many finished items earn one reminder, not one each", () => {
  const many = Array.from({ length: 25 }, (_, index) => ({ id: `t${index}`, content: "done", status: TodoStatus.COMPLETED }))
  const message = renderUpdateTodosSuccessMessage(success(many), "something-else")
  assert.equal(message.match(/Consider cleaning up old ones/g)?.length, 1)
})

test("a few finished items do not", () => {
  const few = Array.from({ length: 3 }, (_, index) => ({ id: `t${index}`, content: "done", status: TodoStatus.COMPLETED }))
  assert.doesNotMatch(renderUpdateTodosSuccessMessage(success(few), "something-else"), /cleaning up old ones/)
})

test("the early version reads its list back as JSON, and only after a merge", () => {
  const todos = [{ id: "a", content: "first", status: TodoStatus.PENDING }]
  const merged = renderUpdateTodosSuccessMessage(success(todos, true), "dsv3-1018")
  assert.match(merged, /\[\{"id":"a","content":"first","status":"pending"\}\]/)

  const replaced = renderUpdateTodosSuccessMessage(success(todos, false), "dsv3-1018")
  assert.doesNotMatch(replaced, /latest contents of your todo list/)
})

test("a merge that was not reported reads as no merge, since the flag defaults to false", () => {
  const message = renderUpdateTodosSuccessMessage(success([
    { id: "a", content: "first", status: TodoStatus.PENDING },
  ]), "dsv3-1018")
  assert.doesNotMatch(message, /latest contents of your todo list/)
})

// ---------------------------------------------------------------------------------------------
// the permissions a shell command may ask for
// ---------------------------------------------------------------------------------------------

test("a network allowlist is its defaults or an explicit entry", () => {
  assert.equal(hasNetworkAllowlist(undefined), false)
  assert.equal(hasNetworkAllowlist({ hasDefaults: false, explicitEntries: [] }), false)
  assert.equal(hasNetworkAllowlist({ hasDefaults: true, explicitEntries: [] }), true)
  assert.equal(hasNetworkAllowlist({ hasDefaults: false, explicitEntries: ["host"] }), true)
})

test("a read-only session may ask for the network and nothing else", () => {
  const schema = getRequiredPermissionsSchema({ isReadonly: true })
  assert.equal(schema.safeParse(["full_network"]).success, true)
  assert.equal(schema.safeParse(["all"]).success, false)
  assert.equal(schema.safeParse(["git_write"]).success, false)
  assert.equal(schema.safeParse(undefined).success, true)
})

test("a strict session may ask for one permission at a time", () => {
  const schema = getRequiredPermissionsSchema({ isReadonly: false, strict: true })
  assert.equal(schema.safeParse(["full_network"]).success, true)
  assert.equal(schema.safeParse(["all"]).success, true)
  assert.equal(schema.safeParse(["full_network", "all"]).success, false)
  assert.equal(schema.safeParse(["git_write"]).success, false)
})

test("an ordinary session may also ask for write access to git", () => {
  const schema = getRequiredPermissionsSchema({ isReadonly: false })
  assert.equal(schema.safeParse(["git_write"]).success, true)
  assert.equal(schema.safeParse(["network"]).success, true)
  assert.equal(schema.safeParse(["something_else"]).success, false)
})

test("a single permission written as a bare word is read as a list", () => {
  const schema = getRequiredPermissionsSchema({ isReadonly: false })
  assert.deepEqual(schema.parse("git_write"), ["git_write"])
  // Two items written as one string are not a list anyone can read, so they are refused.
  assert.equal(schema.safeParse("full_network, all").success, false)
})
