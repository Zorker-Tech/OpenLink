import { test } from "node:test"
import assert from "node:assert/strict"

import { createReadonlyResourceAccessor } from "../../source/packages/agent-exec/readonly-resource-accessor.ts"
import { backgroundShellExecutorResource, writeBackgroundShellInputExecutorResource } from "../../source/packages/agent-exec/background-shell.ts"
import { deleteExecutorResource } from "../../source/packages/agent-exec/delete.ts"
import { mcpExecutorResource } from "../../source/packages/agent-exec/mcp-operations.ts"
import { readExecutorResource } from "../../source/packages/agent-exec/read-operation.ts"
import { shellExecutorResource } from "../../source/packages/agent-exec/shell.ts"
import { shellStreamExecutorResource } from "../../source/packages/agent-exec/shell-stream-operation.ts"
import { writeExecutorResource } from "../../source/packages/agent-exec/write-operation.ts"
import type { ResourceAccessor, RemoteResource } from "../../source/packages/agent-exec/resource-provider.ts"
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts"
import { createContext } from "../../source/packages/context/context.ts"
import type { BackgroundShellSpawnResult } from "../../source/adapters/interop/proto/generated/agent/v1/background_shell_exec_pb.ts"
import type { DeleteResult } from "../../source/adapters/interop/proto/generated/agent/v1/delete_exec_pb.ts"
import type { McpResult } from "../../source/adapters/interop/proto/generated/agent/v1/mcp_exec_pb.ts"
import type { ShellResult, ShellStream } from "../../source/adapters/interop/proto/generated/agent/v1/shell_exec_pb.ts"
import type { WriteResult } from "../../source/adapters/interop/proto/generated/agent/v1/write_exec_pb.ts"

// ---------------------------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------------------------

/** Everything the base accessor was asked for, so what the read-only layer left alone is visible. */
const asked: string[] = []

const BASE_RESOURCES = new Map<symbol, string>([
  [readExecutorResource.symbol, "read"],
  [writeExecutorResource.symbol, "write"],
  [deleteExecutorResource.symbol, "delete"],
  [mcpExecutorResource.symbol, "mcp"],
  [shellExecutorResource.symbol, "shell"],
  [shellStreamExecutorResource.symbol, "shellStream"],
  [backgroundShellExecutorResource.symbol, "backgroundShell"],
])

const baseAccessor: ResourceAccessor<RemoteExecManager> = {
  get<Implementation>(resource: RemoteResource<Implementation, RemoteExecManager>): Implementation {
    const name = BASE_RESOURCES.get(resource.symbol) ?? "unknown"
    asked.push(name)
    return { from: name } as Implementation
  },
}

const ctx = createContext()

function accessor(wrapShell: boolean) {
  asked.length = 0
  return createReadonlyResourceAccessor(baseAccessor, wrapShell)
}

const execute = async <T>(implementation: unknown, args: unknown): Promise<T> =>
  await (implementation as { execute(ctx: unknown, args: unknown): Promise<T> }).execute(ctx, args)

const collect = async (implementation: unknown, args: unknown): Promise<unknown[]> => {
  const events: unknown[] = []
  for await (const event of (implementation as { execute(ctx: unknown, args: unknown): AsyncIterable<unknown> }).execute(ctx, args)) events.push(event)
  return events
}

const READONLY_REASON = /not allowed in readonly mode/
const READONLY_LAUNCH = /launched with readonly: true/

// ---------------------------------------------------------------------------------------------
// what is left alone
// ---------------------------------------------------------------------------------------------

test("a read-only subagent reads through the accessor underneath", () => {
  const readonly = accessor(true)
  assert.deepEqual(readonly.get(readExecutorResource), { from: "read" })
  assert.deepEqual(asked, ["read"])
})

test("a resource the read-only layer does not know is answered underneath", () => {
  const unknown = { symbol: Symbol("something-else") } as unknown as RemoteResource<unknown, RemoteExecManager>
  assert.deepEqual(accessor(true).get(unknown), { from: "unknown" })
})

// ---------------------------------------------------------------------------------------------
// what is refused
// ---------------------------------------------------------------------------------------------

test("writing a file is refused as a read-only policy", async () => {
  const result = await execute<WriteResult>(accessor(true).get(writeExecutorResource), { path: "/repo/a.ts" })
  assert.equal(result.result.case, "permissionDenied")
  const value = (result.result as { value: { path: string; error: string; isReadonly: boolean } }).value
  assert.equal(value.path, "/repo/a.ts")
  assert.equal(value.isReadonly, true)
  assert.match(value.error, READONLY_REASON)
  assert.match(value.error, READONLY_LAUNCH)
  // The write never reached the accessor underneath.
  assert.deepEqual(asked, [])
})

test("deleting a path is refused as a read-only policy", async () => {
  const result = await execute<DeleteResult>(accessor(true).get(deleteExecutorResource), { path: "/repo/old.ts" })
  assert.equal(result.result.case, "permissionDenied")
  const value = (result.result as { value: { path: string; clientVisibleError: string; isReadonly: boolean } }).value
  assert.equal(value.path, "/repo/old.ts")
  assert.equal(value.isReadonly, true)
  assert.match(value.clientVisibleError, READONLY_REASON)
})

test("an MCP tool is refused by name", async () => {
  const result = await execute<McpResult>(accessor(true).get(mcpExecutorResource), { name: "create_issue" })
  assert.equal(result.result.case, "permissionDenied")
  const value = (result.result as { value: { error: string; isReadonly: boolean } }).value
  assert.equal(value.isReadonly, true)
  assert.match(value.error, READONLY_REASON)
  assert.match(value.error, /Tool: create_issue$/)
})

// ---------------------------------------------------------------------------------------------
// shells
// ---------------------------------------------------------------------------------------------

test("running a command is refused when shells are wrapped", async () => {
  const result = await execute<ShellResult>(accessor(true).get(shellExecutorResource), { command: "npm test", workingDirectory: "/repo" })
  assert.equal(result.result.case, "permissionDenied")
  const value = (result.result as { value: { command: string; workingDirectory: string; error: string; isReadonly: boolean } }).value
  assert.equal(value.command, "npm test")
  assert.equal(value.workingDirectory, "/repo")
  assert.equal(value.isReadonly, true)
  assert.match(value.error, READONLY_REASON)
})

test("a streamed command is refused with the same answer", async () => {
  const events = await collect(accessor(true).get(shellStreamExecutorResource), { command: "npm test" })
  assert.equal(events.length, 1)
  const event = (events[0] as { event: { case: string; value: { command: string; error: string } } }).event
  assert.equal(event.case, "permissionDenied")
  assert.equal(event.value.command, "npm test")
  assert.match(event.value.error, READONLY_REASON)
})

test("a background command is refused with the same answer", async () => {
  const result = await execute<BackgroundShellSpawnResult>(accessor(true).get(backgroundShellExecutorResource), { command: "npm run watch" })
  assert.equal(result.result.case, "permissionDenied")
  assert.match((result.result as { value: { error: string } }).value.error, READONLY_REASON)
})

test("a command with nothing to name is still refused", async () => {
  const result = await execute<ShellResult>(accessor(true).get(shellExecutorResource), {})
  const value = (result.result as { value: { command: string; workingDirectory: string } }).value
  assert.equal(value.command, "")
  assert.equal(value.workingDirectory, "")
})

test("shells are left alone when the caller does not ask for them", () => {
  const readonly = accessor(false)
  assert.deepEqual(readonly.get(shellExecutorResource), { from: "shell" })
  assert.deepEqual(readonly.get(shellStreamExecutorResource), { from: "shellStream" })
  assert.deepEqual(readonly.get(backgroundShellExecutorResource), { from: "backgroundShell" })
  // Writing is still refused in that case.
  assert.notDeepEqual(readonly.get(writeExecutorResource), { from: "write" })
})

test("writing to a running shell is left to the accessor underneath", () => {
  // The read-only layer builds this executor but does not install it, so a read-only subagent that may
  // run commands may also type into them.
  const readonly = accessor(true)
  assert.deepEqual(readonly.get(writeBackgroundShellInputExecutorResource), { from: "unknown" })
})
