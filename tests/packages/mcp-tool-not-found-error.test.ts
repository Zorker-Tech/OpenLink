import { test } from "node:test"
import assert from "node:assert/strict"

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
