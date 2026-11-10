import { test } from "node:test"
import assert from "node:assert/strict"
import vm from "node:vm"

import { McpToolNotFoundError, isMcpToolNotFoundError } from "../../source/packages/mcp-agent-exec/mcp-tool-not-found-error.ts"

test("the error says which tool was missing and what there was instead", () => {
  const error = new McpToolNotFoundError("create_issue", ["list_issues", "read_issue"])
  assert.equal(error.name, "McpToolNotFoundError")
  assert.equal(error.toolName, "create_issue")
  assert.deepEqual(error.availableTools, ["list_issues", "read_issue"])
  assert.equal(error.message, "Tool create_issue not found, available tools: list_issues, read_issue")
  assert.equal(error instanceof Error, true)
})

test("a server with nothing to offer still says what was missing", () => {
  const error = new McpToolNotFoundError("create_issue", [])
  assert.equal(error.message, "Tool create_issue not found, available tools: ")
})

test("the error is recognized by its class", () => {
  assert.equal(isMcpToolNotFoundError(new McpToolNotFoundError("a", [])), true)
})

test("the error is recognized by its shape when the class is not the same one", () => {
  // An error from another realm — a host process or a worker — keeps the name and the fields but not the
  // class identity, which is why the name is on the instance rather than only on the class.
  const foreign = Object.assign(new Error("Tool a not found"), {
    name: "McpToolNotFoundError",
    toolName: "a",
    availableTools: ["b"],
  })
  assert.equal(foreign instanceof McpToolNotFoundError, false)
  assert.equal(isMcpToolNotFoundError(foreign), true)
})

test("an error that only looks similar is not one", () => {
  const named = Object.assign(new Error("Tool a not found"), { name: "McpToolNotFoundError" })
  assert.equal(isMcpToolNotFoundError(named), false)
  const wrongToolName = Object.assign(new Error("Tool a not found"), { name: "McpToolNotFoundError", toolName: 7, availableTools: [] })
  assert.equal(isMcpToolNotFoundError(wrongToolName), false)
  const wrongTools = Object.assign(new Error("Tool a not found"), { name: "McpToolNotFoundError", toolName: "a", availableTools: "b" })
  assert.equal(isMcpToolNotFoundError(wrongTools), false)
})

test("anything that is not that error is not one", () => {
  assert.equal(isMcpToolNotFoundError(new Error("something else")), false)
  assert.equal(isMcpToolNotFoundError("Tool a not found"), false)
  assert.equal(isMcpToolNotFoundError(undefined), false)
  assert.equal(isMcpToolNotFoundError(null), false)
})

test("the error keeps the list it was given and names both in the message", () => {
  const tools = ["list_issues", "read_issue"]
  const error = new McpToolNotFoundError("create_issue", tools)
  assert.equal(error.availableTools, tools, "the caller's list is kept, not copied")
  assert.equal(error.message, "Tool create_issue not found, available tools: list_issues, read_issue")
})

test("the error's own fields are enumerable, in the order it is built", () => {
  const error = new McpToolNotFoundError("a", [])
  assert.deepEqual(Object.keys(error), ["toolName", "availableTools", "name"])
  assert.equal(Object.prototype.propertyIsEnumerable.call(error, "message"), false, "the message stays the base error's field")
})

test("a subclass of the error is recognized by its class", () => {
  class SpecializedToolNotFoundError extends McpToolNotFoundError {}
  assert.equal(isMcpToolNotFoundError(new SpecializedToolNotFoundError("a", [])), true)
})

test("the error is recognized by its class even after its name and fields were changed", () => {
  const error = new McpToolNotFoundError("a", [])
  error.name = "SomethingElse"
  ;(error as { toolName: unknown }).toolName = 7
  assert.equal(isMcpToolNotFoundError(error), true, "the class is enough; the shape only matters across realms")
})

test("a foreign shape is recognized by the name and the two fields, whatever they hold", () => {
  const emptyName = Object.assign(new Error("x"), { name: "McpToolNotFoundError", toolName: "", availableTools: [] })
  assert.equal(isMcpToolNotFoundError(emptyName), true, "an empty tool name is still a string")
  const oddList = Object.assign(new Error("x"), { name: "McpToolNotFoundError", toolName: "a", availableTools: [1, 2, null] })
  assert.equal(isMcpToolNotFoundError(oddList), true, "the list only has to be a list")
})

test("the name is matched exactly", () => {
  for (const name of ["mcptoolnotfounderror", "McpToolNotFound", " MCPToolNotFoundError", "McpToolNotFoundError "]) {
    assert.equal(isMcpToolNotFoundError(Object.assign(new Error("x"), { name, toolName: "a", availableTools: [] })), false, name)
  }
})

test("an object that is not an error is not recognized, even with the name and the fields", () => {
  assert.equal(isMcpToolNotFoundError({ name: "McpToolNotFoundError", toolName: "a", availableTools: [] }), false)
  assert.equal(isMcpToolNotFoundError("McpToolNotFoundError"), false)
})

test("an error from another realm is not recognized by its shape, because the check needs this realm's Error", () => {
  // The doc says the shape survives a class identity being lost; a truly other realm's Error fails the
  // instanceof check first, so only a shape on this realm's Error (or another copy of the class) is seen.
  const foreign = vm.runInNewContext("new Error('Tool a not found')") as Error & { toolName?: unknown; availableTools?: unknown }
  foreign.name = "McpToolNotFoundError"
  foreign.toolName = "a"
  foreign.availableTools = ["b"]
  assert.equal(foreign instanceof Error, false)
  assert.equal(isMcpToolNotFoundError(foreign), false)
})
