import { test } from "node:test"
import assert from "node:assert/strict"

import {
  adoptExecutorResource,
  agentStoreConflictExecutorResource,
  agentStoreConflictNoticeExecutorResource,
  backgroundShellExecutorResource,
  canvasDiagnosticsExecutorResource,
  conversationSearchExecutorResource,
  deleteExecutorResource,
  diagnosticsExecutorResource,
  fetchExecutorResource,
  gitDiffExecutorResource,
  grepExecutorResource,
  lsExecutorResource,
  mcpAllowlistPrecheckExecutorResource,
  miniSweAgentBashExecutorResource,
  piBashExecutorResource,
  piReadExecutorResource,
  recordScreenExecutorResource,
  shellAllowlistPrecheckExecutorResource,
  shellExecutorResource,
  slateSubagentAwaitExecutorResource,
  webFetchAllowlistPrecheckExecutorResource,
  writeBackgroundShellInputExecutorResource,
  writeExecutorResource,
} from "../../source/packages/agent-exec/index.ts"
import { ExecutorResource, type RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts"
import { RemoteResourceAccessor, RegistryResourceAccessor } from "../../source/packages/agent-exec/resource-provider.ts"
import { SimpleControlledExecManager } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts"
import {
  decodeBackgroundWorkMetadata,
  encodeBackgroundWorkMetadata,
} from "../../source/packages/agent-exec/background-work-metadata.ts"
import {
  MCP_DISK_CATALOG_MCPS_DIR,
  MCP_DISK_CATALOG_TOOLS_DIR,
  parseMcpToolNameFromDiskDefinitionJson,
} from "../../source/packages/agent-exec/mcp-disk-catalog.ts"
import {
  COMPUTER_USE_SCREENSHOT_SETTLE_DELAY_MS,
  summarizeComputerUseActions,
} from "../../source/packages/agent-exec/computer-use.ts"
import {
  AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES,
  describeOutputLocation,
} from "../../source/adapters/interop/agent/agent-tools-file-adapter.ts"
import { MCP_TEXT_FILE_THRESHOLD_BYTES } from "../../source/packages/agent/tools/mcp/mcp-output-spill-policy.ts"
import {
  createForcePromptHookApprovalRequirement,
  getShellHookApprovalRequirement,
  setShellHookApprovalRequirement,
} from "../../source/adapters/interop/agent/shell-hook-approval-adapter.ts"
import {
  execHookConversationIdKey,
  execHookGenerationIdKey,
  execHookModelKey,
  execHookWorkspaceRootsKey,
} from "../../source/packages/agent-exec/hook-metadata.ts"
import {
  RemoteAgentStoreConflictNoticeStub,
  conflictNoticeAck,
  conflictNoticeNoteDeferredEagerWrittenPaths,
  conflictNoticePeek,
  conflictNoticeRelease,
  conflictNoticeSyncAndPeek,
} from "../../source/packages/agent-exec/agent-store-conflict-notice.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import type { LsExecutorArgs, LsExecutorResult } from "../../source/packages/agent-exec/ls.ts"
import { ExecClientMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts"
import {
  ShellHookApprovalRequirement,
  ShellHookApprovalRequirement_Kind,
} from "../../source/adapters/interop/proto/generated/agent/v1/shell_exec_pb.ts"
import type { OutputLocation } from "../../source/adapters/interop/proto/generated/agent/v1/utils_pb.ts"

// ---------------------------------------------------------------------------------------------
// the operations this daemon can serve
// ---------------------------------------------------------------------------------------------

test("every operation is its own resource, so two of them are never the same call", () => {
  const symbols = [
    lsExecutorResource,
    grepExecutorResource,
    fetchExecutorResource,
    deleteExecutorResource,
    gitDiffExecutorResource,
    diagnosticsExecutorResource,
    canvasDiagnosticsExecutorResource,
    conversationSearchExecutorResource,
    adoptExecutorResource,
    agentStoreConflictExecutorResource,
    agentStoreConflictNoticeExecutorResource,
    recordScreenExecutorResource,
    miniSweAgentBashExecutorResource,
    piBashExecutorResource,
    piReadExecutorResource,
    shellExecutorResource,
    backgroundShellExecutorResource,
    writeBackgroundShellInputExecutorResource,
    slateSubagentAwaitExecutorResource,
    shellAllowlistPrecheckExecutorResource,
    mcpAllowlistPrecheckExecutorResource,
    webFetchAllowlistPrecheckExecutorResource,
    writeExecutorResource,
  ].map(resource => resource.symbol)
  assert.equal(new Set(symbols).size, symbols.length)
})

test("an operation runs where the host is, over the exec channel", async () => {
  const registry = new RegistryResourceAccessor()
  let calls = 0
  registry.register(lsExecutorResource, {
    async execute(_ctx: Context, args: LsExecutorArgs): Promise<LsExecutorResult> {
      calls += 1
      return {
        kind: "success",
        root: {
          absPath: args.path,
          childrenWereProcessed: true,
          childrenFiles: [],
          childrenDirs: [],
          numFiles: 0,
          fullSubtreeExtensionCounts: {},
        },
      }
    },
  })
  const serving = SimpleControlledExecManager.fromResources(registry)
  const client = new RemoteResourceAccessor<RemoteExecManager>({
    createExecInstance(context, createMessage) {
      return (async function* () {
        for await (const message of serving.handle(context, createMessage(7))) yield message as ExecClientMessage
      })()
    },
  })

  const result = await client.get(lsExecutorResource).execute(createContext(), { path: "/repo" })
  assert.equal(calls, 1)
  assert.equal(result.kind, "success")
  assert.equal(result.kind === "success" ? result.root?.absPath : "", "/repo")
})

test("a client reaches an operation by the resource, and gets an executor for it", () => {
  const client = new RemoteResourceAccessor<RemoteExecManager>({
    createExecInstance() { return (async function* () {})() },
  })
  assert.equal(client.get(grepExecutorResource) instanceof ExecutorResource, true)
})

// ---------------------------------------------------------------------------------------------
// what a background task carries
// ---------------------------------------------------------------------------------------------

test("what identifies a background task survives the store it passes through", () => {
  const encoded = encodeBackgroundWorkMetadata({ title: "the task", cwd: "/repo", startTimeMs: 1_700_000_000_123.7 })
  assert.deepEqual(encoded, { title: "the task", cwd: "/repo", startTimeMs: "1700000000123" })
  assert.deepEqual(decodeBackgroundWorkMetadata(encoded), { title: "the task", cwd: "/repo", startTimeMs: 1_700_000_000_123 })
})

test("a value that cannot be written is left out rather than written wrongly", () => {
  assert.equal(encodeBackgroundWorkMetadata({ title: "   " }), undefined)
  assert.equal(encodeBackgroundWorkMetadata({ startTimeMs: Number.NaN }), undefined)
  assert.equal(encodeBackgroundWorkMetadata({ startTimeMs: -1 }), undefined)
  assert.deepEqual(encodeBackgroundWorkMetadata({ title: "a", cwd: "" }), { title: "a" })
})

test("reading it back tolerates a store that lost or changed a field", () => {
  assert.deepEqual(decodeBackgroundWorkMetadata(undefined), {})
  assert.deepEqual(decodeBackgroundWorkMetadata(null), {})
  assert.deepEqual(decodeBackgroundWorkMetadata({ title: 42, cwd: "  ", startTimeMs: "not a number" }), {})
  // A number kept as text is still a number.
  assert.deepEqual(decodeBackgroundWorkMetadata({ startTimeMs: "1700" }), { startTimeMs: 1_700 })
})

// ---------------------------------------------------------------------------------------------
// where a server's tool definitions live
// ---------------------------------------------------------------------------------------------

test("a server's tools live in a directory of their own", () => {
  assert.equal(MCP_DISK_CATALOG_MCPS_DIR, "mcps")
  assert.equal(MCP_DISK_CATALOG_TOOLS_DIR, "tools")
})

test("a tool's name is read from inside its definition, not from its filename", () => {
  assert.equal(parseMcpToolNameFromDiskDefinitionJson(JSON.stringify({ name: "search" })), "search")
  assert.equal(parseMcpToolNameFromDiskDefinitionJson(JSON.stringify({ toolName: "search" })), "search")
  // The name field wins when both are there.
  assert.equal(parseMcpToolNameFromDiskDefinitionJson(JSON.stringify({ name: "one", toolName: "two" })), "one")
})

test("a definition that does not parse yields no name rather than an error", () => {
  assert.equal(parseMcpToolNameFromDiskDefinitionJson("{ not json"), undefined)
  assert.equal(parseMcpToolNameFromDiskDefinitionJson("[]"), undefined)
  assert.equal(parseMcpToolNameFromDiskDefinitionJson("null"), undefined)
  assert.equal(parseMcpToolNameFromDiskDefinitionJson(JSON.stringify({ name: "" })), undefined)
  assert.equal(parseMcpToolNameFromDiskDefinitionJson(JSON.stringify({ other: "value" })), undefined)
})

// ---------------------------------------------------------------------------------------------
// what a computer-use call amounted to
// ---------------------------------------------------------------------------------------------

test("a computer-use call is summarized by what it did, not by how long it ran", () => {
  const summary = summarizeComputerUseActions([
    { kind: "click" },
    { kind: "click" },
    { kind: "type-text" },
    { kind: "key-press" },
    { kind: "pause" },
    { kind: "screenshot" },
    { kind: "pointer-position" },
    { kind: undefined },
  ])
  assert.equal(summary.actionCount, 8)
  assert.deepEqual(summary.actionCounts, {
    mouse_move: 0,
    click: 2,
    mouse_down: 0,
    mouse_up: 0,
    drag: 0,
    scroll: 0,
    type: 1,
    key: 1,
    wait: 1,
    screenshot: 1,
    cursor_position: 1,
  })
})

test("an empty computer-use call counts nothing", () => {
  const summary = summarizeComputerUseActions([])
  assert.equal(summary.actionCount, 0)
  assert.equal(Object.values(summary.actionCounts).every(count => count === 0), true)
})

test("the pause between an action and its screenshot is a property of the screen", () => {
  assert.equal(COMPUTER_USE_SCREENSHOT_SETTLE_DELAY_MS, 2_000)
})

// ---------------------------------------------------------------------------------------------
// where a large tool output went
// ---------------------------------------------------------------------------------------------

test("the description of a written output names the file, its size and its lines", () => {
  const location = { filePath: "/repo/.slate/agent-tools/out.txt", sizeBytes: 2_048n, lineCount: 120n } as unknown as OutputLocation
  assert.equal(
    describeOutputLocation(location),
    "Content written to file: /repo/.slate/agent-tools/out.txt\nSize: 2.0 KB, 120 lines",
  )
  // A small output is described in bytes rather than in a fraction of a kilobyte.
  const small = { filePath: "/repo/out.txt", sizeBytes: 512n, lineCount: 3n } as unknown as OutputLocation
  assert.match(describeOutputLocation(small), /Size: 512 bytes, 3 lines/)
  // The caller may say what the content was.
  assert.match(describeOutputLocation(small, { leadText: "Output" }), /^Output written to file:/)
})

test("the thresholds that decide a file differ for text and for MCP output", () => {
  assert.equal(AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES, 20_000)
  assert.equal(MCP_TEXT_FILE_THRESHOLD_BYTES, 40_000)
})

// ---------------------------------------------------------------------------------------------
// approval decided by a hook
// ---------------------------------------------------------------------------------------------

/** The shape the requirement hangs off: the shell call's own arguments. */
interface ApprovalArgs {
  hookApprovalRequirement?: ShellHookApprovalRequirement | undefined
}

test("a session's approval requirement is set, read and cleared", () => {
  const args: ApprovalArgs = {}
  assert.equal(getShellHookApprovalRequirement(args), undefined)

  const requirement = createForcePromptHookApprovalRequirement("the hook asked for a prompt")
  setShellHookApprovalRequirement(args, requirement)
  assert.equal(getShellHookApprovalRequirement(args)?.kind, ShellHookApprovalRequirement_Kind.FORCE_PROMPT)
  assert.equal(getShellHookApprovalRequirement(args)?.reason, "the hook asked for a prompt")

  setShellHookApprovalRequirement(args, undefined)
  assert.equal(getShellHookApprovalRequirement(args), undefined)
})

test("a requirement is copied rather than taken by reference", () => {
  const args: ApprovalArgs = {}
  const requirement = new ShellHookApprovalRequirement({ kind: ShellHookApprovalRequirement_Kind.FORCE_PROMPT, reason: "once" })
  setShellHookApprovalRequirement(args, requirement)
  requirement.reason = "changed after"
  assert.equal(getShellHookApprovalRequirement(args)?.reason, "once")
})

// ---------------------------------------------------------------------------------------------
// what a hook is told about the call
// ---------------------------------------------------------------------------------------------

test("the facts a hook reads travel on the context, one key each", () => {
  const keys = [execHookConversationIdKey, execHookGenerationIdKey, execHookModelKey, execHookWorkspaceRootsKey]
  assert.equal(new Set(keys).size, keys.length)

  const ctx = createContext()
  assert.equal(ctx.get(execHookConversationIdKey), undefined)
  const withFacts = ctx.with(execHookConversationIdKey, "conversation-1").with(execHookModelKey, "composer-2")
  assert.equal(withFacts.get(execHookConversationIdKey), "conversation-1")
  assert.equal(withFacts.get(execHookModelKey), "composer-2")
  assert.equal(withFacts.get(execHookWorkspaceRootsKey), undefined)
})

// ---------------------------------------------------------------------------------------------
// the notices a store conflict produces
// ---------------------------------------------------------------------------------------------

function recordingExecutor(): { readonly calls: Array<{ op: string; args: Record<string, unknown> }>; readonly executor: { execute(ctx: unknown, args: Record<string, unknown>, options?: unknown): Promise<unknown> } } {
  const calls: Array<{ op: string; args: Record<string, unknown> }> = []
  return {
    calls,
    executor: {
      async execute(_ctx, args) { calls.push({ op: String(args.op), args }); return { kind: "ok" } },
    },
  }
}

test("reading the notices asks the host for them", async () => {
  const { executor, calls } = recordingExecutor()
  await conflictNoticePeek(executor, createContext(), { conversationId: "conversation-1" })
  assert.deepEqual(calls[0]?.args, { op: "peek", conversationId: "conversation-1" })
})

test("syncing before reading passes what was written while waiting", async () => {
  const { executor, calls } = recordingExecutor()
  await conflictNoticeSyncAndPeek(executor, createContext(), {
    conversationId: "conversation-1",
    writtenPaths: ["/repo/a.ts"],
    timeoutMs: 500,
    eager: true,
  })
  assert.deepEqual(calls[0]?.args, {
    op: "syncAndPeek",
    conversationId: "conversation-1",
    writtenPaths: ["/repo/a.ts"],
    timeoutMs: 500,
    eager: true,
  })
})

test("acknowledging nothing asks the host nothing", async () => {
  const { executor, calls } = recordingExecutor()
  await conflictNoticeAck(executor, createContext(), [])
  await conflictNoticeRelease(executor, createContext(), [])
  await conflictNoticeNoteDeferredEagerWrittenPaths(executor, createContext(), [])
  assert.deepEqual(calls, [])
})

test("acknowledging and releasing name the events they are about", async () => {
  const { executor, calls } = recordingExecutor()
  await conflictNoticeAck(executor, createContext(), ["event-1"], { conversationId: "conversation-1" })
  await conflictNoticeRelease(executor, createContext(), ["event-2"])
  await conflictNoticeNoteDeferredEagerWrittenPaths(executor, createContext(), ["/repo/a.ts"])
  assert.deepEqual(calls.map(call => call.op), ["ack", "release", "noteDeferredEagerWrittenPaths"])
  assert.deepEqual(calls[0]?.args.eventIds, ["event-1"])
  assert.deepEqual(calls[2]?.args.writtenPaths, ["/repo/a.ts"])
})

test("a session with no host to ask gets the answer that says so", async () => {
  const stub = new RemoteAgentStoreConflictNoticeStub()
  assert.deepEqual(await stub.execute(createContext(), { op: "ack" }), { kind: "acked", count: 0 })
  assert.deepEqual(await stub.execute(createContext(), { op: "peek" }), { kind: "not-applicable" })
})
