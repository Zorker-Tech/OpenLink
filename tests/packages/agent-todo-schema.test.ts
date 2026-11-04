import { test } from "node:test"
import assert from "node:assert/strict"

import {
  createSchemaTowardsModel,
  renderUpdateTodosSuccessMessage,
  todoToolSchemaForParsing,
} from "../../source/packages/agent/tools/core/todo/schema.ts"
import type { SlateTodoResult, SlateTodoStatus, TodoPromptProfile } from "../../source/packages/agent/tools/core/todo/contracts.ts"
import {
  getRequiredPermissionsSchema,
  hasNetworkAllowlist,
} from "../../source/packages/agent/tools/core/shell/sandbox-permissions.ts"

// ---------------------------------------------------------------------------------------------
// the todo schema the model is shown
// ---------------------------------------------------------------------------------------------

function profile(overrides: Partial<TodoPromptProfile> = {}): TodoPromptProfile {
  return {
    toolName: "Tasks",
    description: "Manage the session task list.",
    mergeFirst: false,
    contentOptionalInPrompt: false,
    successDisplay: "text",
    ...overrides,
  }
}

test("the inference profile controls task schema shape and property order", () => {
  const early = createSchemaTowardsModel(profile({ mergeFirst: true, contentOptionalInPrompt: true }))
  assert.deepEqual(Object.keys(early.shape), ["merge", "todos"])
  assert.deepEqual(Object.keys(early.shape.todos.element.shape), ["content", "status", "id"])

  const later = createSchemaTowardsModel(profile())
  assert.deepEqual(Object.keys(later.shape), ["todos", "merge"])
  assert.deepEqual(Object.keys(later.shape.todos.element.shape), ["id", "content", "status"])

  const defaultOrder = createSchemaTowardsModel(profile())
  assert.deepEqual(Object.keys(defaultOrder.shape), ["todos", "merge"])
  const mergeFirst = createSchemaTowardsModel(profile({ mergeFirst: true }))
  assert.deepEqual(Object.keys(mergeFirst.shape), ["merge", "todos"])
})

test("a profile may allow an update that only changes status", () => {
  const early = createSchemaTowardsModel(profile({ contentOptionalInPrompt: true }))
  assert.equal(early.safeParse({ merge: true, todos: [{ id: "a", status: "in_progress" }] }).success, true)
  const later = createSchemaTowardsModel(profile())
  assert.equal(later.safeParse({ merge: true, todos: [{ id: "a", status: "in_progress" }] }).success, false)
})

test("a minimum list size is enforced only when the profile requires it", () => {
  const withMin = createSchemaTowardsModel(profile({ minimumTodoCount: 2 }))
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

function success(
  todos: Array<{ id: string; content: string; status: SlateTodoStatus }>,
  wasMerge = true,
): Extract<SlateTodoResult, { readonly kind: "success" }> {
  return {
    kind: "success",
    todos: todos.map(todo => ({ ...todo, createdAt: 0n, updatedAt: 0n })),
    totalCount: todos.length,
    wasMerge,
  }
}

test("the list comes back as lines, and a list with nothing in progress is called out", () => {
  const message = renderUpdateTodosSuccessMessage(success([
    { id: "a", content: "first", status: "pending" },
  ]), profile())
  assert.match(message, /Task list updated/)
  assert.match(message, /No task is marked in progress/)
  assert.match(message, /- \*\*PENDING\*\*: first \(id: a\)/)
})

test("a list with something in progress is not called out", () => {
  const message = renderUpdateTodosSuccessMessage(success([
    { id: "a", content: "first", status: "in_progress" },
  ]), profile())
  assert.doesNotMatch(message, /No task is marked in progress/)
})

test("many finished items earn one reminder, not one each", () => {
  const many = Array.from({ length: 25 }, (_, index) => ({ id: "t" + index, content: "done", status: "completed" as const }))
  const message = renderUpdateTodosSuccessMessage(success(many), profile())
  assert.equal(message.match(/consider removing old entries/g)?.length, 1)
})

test("a few finished items do not", () => {
  const few = Array.from({ length: 3 }, (_, index) => ({ id: "t" + index, content: "done", status: "completed" as const }))
  assert.doesNotMatch(renderUpdateTodosSuccessMessage(success(few), profile()), /removing old entries/)
})

test("a profile may read the merged task list back as JSON", () => {
  const todos = [{ id: "a", content: "first", status: "pending" as const }]
  const jsonProfile = profile({ successDisplay: "json-on-merge" })
  const merged = renderUpdateTodosSuccessMessage(success(todos, true), jsonProfile)
  assert.match(merged, /\[\{"id":"a","content":"first","status":"pending"\}\]/)

  const replaced = renderUpdateTodosSuccessMessage(success(todos, false), jsonProfile)
  assert.doesNotMatch(replaced, /Current task list/)
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
  assert.equal(schema.safeParse(["network"]).success, true)
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

test("each session policy describes its available permissions", () => {
  assert.equal(
    getRequiredPermissionsSchema({ isReadonly: true }).description,
    "Optional list of permissions to request if the command needs them (full_network).",
  )
  assert.equal(
    getRequiredPermissionsSchema({ isReadonly: false, strict: true }).description,
    "Optional list of permissions to request if the command needs them (full_network, all).",
  )
  assert.equal(
    getRequiredPermissionsSchema({ isReadonly: false }).description,
    "Optional list of permissions to request if the command needs them (full_network, all).",
  )
})
