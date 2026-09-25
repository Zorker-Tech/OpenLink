import { test } from "node:test"
import assert from "node:assert/strict"

import {
  assertMcpToolIsCallable,
  checkToolDefinitionRead,
} from "../../source/packages/agent/tools/mcp/mcp-execution-guards.ts"
import {
  indexMcpDescriptors,
  type McpDescriptorIndex,
} from "../../source/packages/agent/tools/mcp/mcp-call-options.ts"
import {
  McpExecToolNotFoundError,
  McpServerDoesNotExistError,
} from "../../source/packages/agent/tools/mcp/mcp-result-boundary.ts"
import { McpDescriptor, McpMetaToolOptions, McpToolDescriptor } from "../../source/packages/proto/generated/agent/v1/mcp_pb.ts"
import { safeString } from "../../source/packages/redaction/create.ts"
import type { RedactedString } from "../../source/packages/redaction/redacted-values.ts"
import { PrivacyCapability } from "../../source/packages/redaction/classification.ts"

// ---------------------------------------------------------------------------------------------
// is the tool there at all
// ---------------------------------------------------------------------------------------------

function sessionWith(descriptors: McpDescriptor[]): McpDescriptorIndex {
  return indexMcpDescriptors({ mcpMetaToolEnabled: true, mcpMetaToolOptions: new McpMetaToolOptions({ enabled: true, mcpDescriptors: descriptors }) })
}

const serverWithSearch = sessionWith([
  new McpDescriptor({
    serverIdentifier: "server-a",
    serverName: "Server A",
    folderPath: "/repo/mcps/server-a",
    tools: [
      new McpToolDescriptor({ toolName: "search", definitionPath: "/repo/mcps/server-a/search.md" }),
      new McpToolDescriptor({ toolName: "fetch" }),
    ],
  }),
])

test("a tool this session has is allowed through", () => {
  assertMcpToolIsCallable(serverWithSearch, "server-a", "search", "GetMcpTools", false)
  assertMcpToolIsCallable(serverWithSearch, "server-a", "fetch", "GetMcpTools", false)
})

test("a server this session does not have is refused with where to look", () => {
  assert.throws(
    () => assertMcpToolIsCallable(serverWithSearch, "server-b", "search", "GetMcpTools", false),
    (error: unknown) => error instanceof McpServerDoesNotExistError &&
      error.modelVisibleErrorMessage === "MCP server does not exist: server-b. Use GetMcpTools to discover available servers.",
  )
  assert.throws(
    () => assertMcpToolIsCallable(serverWithSearch, "server-b", "search", "GetMcpTools", true),
    (error: unknown) => error instanceof McpServerDoesNotExistError &&
      error.readServerDefReminder === "Use GetMcpTools to discover available namespaces.",
  )
})

test("a tool the server does not have is refused with where to look", () => {
  assert.throws(
    () => assertMcpToolIsCallable(serverWithSearch, "server-a", "no-such-tool", "GetMcpTools", false),
    (error: unknown) => error instanceof McpExecToolNotFoundError &&
      error.modelVisibleErrorMessage === "Tool no-such-tool was not found. Use GetMcpTools to discover available servers and their tools.",
  )
  assert.throws(
    () => assertMcpToolIsCallable(serverWithSearch, "server-a", "no-such-tool", "GetMcpTools", true),
    (error: unknown) => error instanceof McpExecToolNotFoundError &&
      error.modelVisibleErrorMessage.includes("discover available namespaces and their tools"),
  )
})

// ---------------------------------------------------------------------------------------------
// has the definition been read
// ---------------------------------------------------------------------------------------------

interface ReadPathState {
  hasReadPath(path: RedactedString): boolean
}

const readPaths = (paths: string[]): ReadPathState => ({
  hasReadPath: path => paths.includes(path.unwrap(PrivacyCapability.STORAGE_FOR_TRAINING)),
})

test("a session that does not track what was read is not held to having read anything", () => {
  assert.deepEqual(checkToolDefinitionRead(serverWithSearch, true, "server-a", "search", undefined), { kind: "read" })
})

test("a definition that was read passes and one that was not says which file is missing", () => {
  assert.deepEqual(
    checkToolDefinitionRead(serverWithSearch, true, "server-a", "search", readPaths(["/repo/mcps/server-a/search.md"])),
    { kind: "read" },
  )
  assert.deepEqual(
    checkToolDefinitionRead(serverWithSearch, true, "server-a", "search", readPaths(["/repo/mcps/server-a/other.md"])),
    { kind: "unread", unreadPath: "/repo/mcps/server-a/search.md" },
  )
})

test("a server with no descriptors yet is allowed through only under the meta tool", () => {
  const empty = sessionWith([])
  assert.deepEqual(checkToolDefinitionRead(empty, true, "server-a", "search", readPaths([])), { kind: "read" })
  assert.deepEqual(checkToolDefinitionRead(empty, false, "server-a", "search", readPaths([])), {
    kind: "noServer",
    serverIdentifier: "server-a",
  })
})

test("a server that is simply not there is reported as missing, not as unread", () => {
  assert.deepEqual(checkToolDefinitionRead(serverWithSearch, false, "server-b", "search", readPaths([])), {
    kind: "noServer",
    serverIdentifier: "server-b",
  })
})

test("a tool with no definition file is reported with the server's own folder", () => {
  assert.deepEqual(checkToolDefinitionRead(serverWithSearch, false, "server-a", "fetch", readPaths([])), {
    kind: "noTool",
    toolName: "fetch",
    serverPath: "/repo/mcps/server-a",
  })
})

test("under the meta tool a tool with no definition file needs nothing read", () => {
  assert.deepEqual(checkToolDefinitionRead(serverWithSearch, true, "server-a", "fetch", readPaths([])), { kind: "read" })
})

test("the path that counts as read is the one the session recorded", () => {
  // The session records redacted strings, so the check asks in the same form.
  assert.deepEqual(
    checkToolDefinitionRead(
      serverWithSearch,
      true,
      "server-a",
      "search",
      readPaths([safeString("/repo/mcps/server-a/search.md").unwrap(PrivacyCapability.STORAGE_FOR_TRAINING)]),
    ),
    { kind: "read" },
  )
})
