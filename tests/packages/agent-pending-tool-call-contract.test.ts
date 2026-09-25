import { test } from "node:test"
import assert from "node:assert/strict"

import {
  buildPendingToolExecutionContract,
  collectPendingToolAdmission,
  createPendingToolContractMismatchResult,
  enrichPendingToolCallJson,
  getAdmittedEffectiveToolName,
  readPendingToolExecutionContracts,
  resolveDescriptorForPendingToolCall,
  validatePendingToolContractIdentity,
  type PendingToolExecutionContract,
} from "../../source/packages/agent/pending-tool-call-contract.ts"
import { DYNAMIC_TOOLS_NAMESPACE } from "../../source/packages/agent-exec/mcp-operations.ts"
import type { ToolExecutionSet } from "../../source/packages/agent/tools/tool-execution.ts"

// ---------------------------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------------------------

type ToolRecord = Record<string, unknown> & { name: string; toolIdentifier: string }

const fakeTool = (name: string, toolIdentifier: string, extra: Record<string, unknown> = {}): ToolRecord =>
  ({ name, toolIdentifier, parameters: {}, ...extra })

const executionSet = (tools: ToolRecord[]): ToolExecutionSet =>
  ({ modelVisibleTools: tools, additionalExecutableTools: [] }) as never

/** The identity a tool call resolves to, which is what the contract writes down. */
const resolveIdentity = ({ toolName }: { toolName: string; args: unknown }) =>
  toolName === "Read"
    ? { toolIdentifier: "read", isDynamic: false }
    : toolName === "CallMcpTool"
      ? { toolIdentifier: "call_mcp_tool", isDynamic: true }
      : undefined

const tools = [fakeTool("Read", "read"), fakeTool("CallMcpTool", "call_mcp_tool", { dynamicToolMetaRole: "invocation" })]

const build = (options: { toolCallId?: string; toolName?: string; args?: unknown; allowed?: string[] } = {}) =>
  buildPendingToolExecutionContract({
    toolCallId: options.toolCallId ?? "call-1",
    toolName: options.toolName ?? "Read",
    args: options.args ?? { path: "/a" },
    resolveIdentity,
    toolExecutionSet: executionSet(tools),
    allowedToolNames: options.allowed ?? ["Read", "CallMcpTool"],
  })

// ---------------------------------------------------------------------------------------------
// what is written down with a call
// ---------------------------------------------------------------------------------------------

test("a plain call records its tool and what was allowed", () => {
  const contract = build()
  assert.equal(contract.toolCallId, "call-1")
  assert.equal(contract.outerToolName, "Read")
  assert.equal(contract.toolIdentifier, "read")
  assert.equal(contract.isDynamic, false)
  assert.deepEqual(contract.allowedToolNames, ["Read", "CallMcpTool"])
  assert.equal(contract.effectiveToolName, undefined)
})

test("a dynamic call records the tool it would actually run", () => {
  const contract = build({
    toolName: "CallMcpTool",
    args: { namespace: DYNAMIC_TOOLS_NAMESPACE, toolName: "Read", arguments: '{"path":"/a"}' },
  })
  assert.equal(contract.effectiveToolName, "Read")
  assert.equal(contract.effectiveToolIdentifier, "read")
  assert.equal(contract.isDynamic, true)
})

test("a tool nobody recognizes is recorded as unknown rather than guessed", () => {
  const contract = build({ toolName: "SomethingNew", args: {} })
  assert.equal(contract.toolIdentifier, "unknown")
  assert.equal(contract.isDynamic, false)
})

test("an inner tool the session does not have is not resolved", () => {
  const contract = build({
    toolName: "CallMcpTool",
    args: { namespace: DYNAMIC_TOOLS_NAMESPACE, toolName: "SomethingNew", arguments: "{}" },
  })
  assert.equal(contract.effectiveToolName, undefined)
  // The outer call is a dynamic invocation tool, so the call is dynamic whether or not an inner tool resolved.
  assert.equal(contract.isDynamic, true)
})

test("an inner tool nobody recognizes is still dynamic", () => {
  // The tool is executable but no resolver knows it, so the namespace is what makes it dynamic.
  const contract = buildPendingToolExecutionContract({
    toolCallId: "call-1",
    toolName: "CallMcpTool",
    args: { namespace: DYNAMIC_TOOLS_NAMESPACE, toolName: "Mystery", arguments: "{}" },
    resolveIdentity: () => undefined,
    toolExecutionSet: {
      modelVisibleTools: [fakeTool("CallMcpTool", "call_mcp_tool", { dynamicToolMetaRole: "invocation" })] as never,
      additionalExecutableTools: [fakeTool("Mystery", "mystery")] as never,
    },
    allowedToolNames: ["CallMcpTool"],
  })
  assert.equal(contract.effectiveToolName, "Mystery")
  assert.equal(contract.isDynamic, true)
  assert.equal(contract.effectiveToolIdentifier, "unknown")
})

test("a call whose arguments are not an object is recorded without an inner tool", () => {
  const contract = build({ toolName: "CallMcpTool", args: "not an object" })
  assert.equal(contract.effectiveToolName, undefined)
})

// ---------------------------------------------------------------------------------------------
// what is read back
// ---------------------------------------------------------------------------------------------

test("the contracts a message carries are read back", () => {
  const contract = build()
  const message = { providerOptions: { cursor: { pendingToolExecutionContracts: { "call-1": contract } } } }
  const read = readPendingToolExecutionContracts(message)
  assert.equal(read.size, 1)
  assert.deepEqual(read.get("call-1"), contract)
})

test("a message with no contracts carries none", () => {
  assert.equal(readPendingToolExecutionContracts({}).size, 0)
  assert.equal(readPendingToolExecutionContracts({ providerOptions: {} }).size, 0)
  assert.equal(readPendingToolExecutionContracts({ providerOptions: { cursor: {} } }).size, 0)
  assert.equal(readPendingToolExecutionContracts({ providerOptions: { cursor: { pendingToolExecutionContracts: null } } }).size, 0)
})

test("a contract that is not whole is not read back", () => {
  const message = (value: unknown) => ({ providerOptions: { cursor: { pendingToolExecutionContracts: { "call-1": value } } } })
  assert.equal(readPendingToolExecutionContracts(message({ toolCallId: "call-1" })).size, 0)
  assert.equal(readPendingToolExecutionContracts(message({ toolCallId: "call-1", outerToolName: "Read" })).size, 0)
  assert.equal(readPendingToolExecutionContracts(message({
    toolCallId: "call-1",
    outerToolName: "Read",
    toolIdentifier: "read",
    isDynamic: false,
    allowedToolNames: "Read",
  })).size, 0)
  assert.equal(readPendingToolExecutionContracts(message({
    toolCallId: "call-1",
    outerToolName: "Read",
    toolIdentifier: "read",
    isDynamic: false,
    allowedToolNames: [1, 2],
  })).size, 0)
})

test("a contract stored under another call's id is not that call's", () => {
  const contract = build({ toolCallId: "call-2" })
  const read = readPendingToolExecutionContracts({ providerOptions: { cursor: { pendingToolExecutionContracts: { "call-1": contract } } } })
  assert.equal(read.size, 0)
})

// ---------------------------------------------------------------------------------------------
// writing the contracts onto a pending message
// ---------------------------------------------------------------------------------------------

test("a pending message is enriched with a contract for each of its calls", () => {
  const enriched = enrichPendingToolCallJson(JSON.stringify({
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: "call-1", toolName: "Read", args: { path: "/a" } },
      { type: "text", text: "and then" },
    ],
  }), { resolveIdentity, toolExecutionSet: executionSet(tools), allowedToolNames: ["Read"], pendingToolCallStartedAtMs: 1_000 })
  const parsed = JSON.parse(enriched) as { providerOptions: { cursor: { pendingToolExecutionContracts: Record<string, unknown>; pendingToolCallStartedAtMs: number } } }
  assert.equal(Object.keys(parsed.providerOptions.cursor.pendingToolExecutionContracts).length, 1)
  assert.equal(parsed.providerOptions.cursor.pendingToolCallStartedAtMs, 1_000)
})

test("a start time that is already there is kept", () => {
  const enriched = enrichPendingToolCallJson(JSON.stringify({
    role: "assistant",
    content: [],
    providerOptions: { cursor: { pendingToolCallStartedAtMs: 500 } },
  }), { resolveIdentity, toolExecutionSet: executionSet(tools), allowedToolNames: [], pendingToolCallStartedAtMs: 1_000 })
  const parsed = JSON.parse(enriched) as { providerOptions: { cursor: { pendingToolCallStartedAtMs: number } } }
  assert.equal(parsed.providerOptions.cursor.pendingToolCallStartedAtMs, 500)
})

test("a start time is not invented when the caller does not have one", () => {
  const enriched = enrichPendingToolCallJson(JSON.stringify({ role: "assistant", content: [] }), {
    resolveIdentity, toolExecutionSet: executionSet(tools), allowedToolNames: [],
  })
  const parsed = JSON.parse(enriched) as { providerOptions: { cursor: { pendingToolCallStartedAtMs?: number } } }
  assert.equal(parsed.providerOptions.cursor.pendingToolCallStartedAtMs, undefined)
})

test("contracts already on the message are kept when it is enriched again", () => {
  // An earlier turn's call is still pending, so its contract must survive the new one being added.
  const first = enrichPendingToolCallJson(JSON.stringify({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "call-1", toolName: "Read", args: {} }],
  }), { resolveIdentity, toolExecutionSet: executionSet(tools), allowedToolNames: ["Read"] })
  const second = enrichPendingToolCallJson(JSON.stringify({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "call-2", toolName: "Read", args: {} }],
    providerOptions: (JSON.parse(first) as { providerOptions: unknown }).providerOptions,
  }), {
    resolveIdentity,
    toolExecutionSet: executionSet(tools),
    allowedToolNames: ["Read"],
  })
  const parsed = JSON.parse(second) as { providerOptions: { cursor: { pendingToolExecutionContracts: Record<string, unknown> } } }
  assert.deepEqual(Object.keys(parsed.providerOptions.cursor.pendingToolExecutionContracts).sort(), ["call-1", "call-2"])
})

test("a message that cannot be read is left as it was", () => {
  assert.equal(enrichPendingToolCallJson("not json", { resolveIdentity, toolExecutionSet: executionSet(tools), allowedToolNames: [] }), "not json")
})

test("a message with nothing to enrich is still given its contracts field", () => {
  const enriched = enrichPendingToolCallJson(JSON.stringify({ role: "assistant", content: "a string body" }), {
    resolveIdentity, toolExecutionSet: executionSet(tools), allowedToolNames: [],
  })
  const parsed = JSON.parse(enriched) as { providerOptions: { cursor: { pendingToolExecutionContracts: Record<string, unknown> } } }
  assert.deepEqual(parsed.providerOptions.cursor.pendingToolExecutionContracts, {})
})

// ---------------------------------------------------------------------------------------------
// which names the pending calls admit
// ---------------------------------------------------------------------------------------------

test("a dynamic call admits its inner tool only when its own namespace call was allowed", () => {
  const allowed = new Set(["CallMcpTool"])
  const admitted = getAdmittedEffectiveToolName({
    toolCallId: "call-1",
    toolName: "CallMcpTool",
    args: {},
    effectiveNativeToolCall: { toolName: "Read", args: {} },
  }, allowed)
  assert.equal(admitted, "Read")
  assert.equal(getAdmittedEffectiveToolName({
    toolCallId: "call-1",
    toolName: "CallMcpTool",
    args: {},
    effectiveNativeToolCall: { toolName: "Read", args: {} },
  }, new Set(["Read"])), undefined)
  assert.equal(getAdmittedEffectiveToolName({ toolCallId: "call-1", toolName: "Read", args: {} }, allowed), undefined)
  assert.equal(getAdmittedEffectiveToolName({
    toolCallId: "call-1",
    toolName: "CallMcpTool",
    args: {},
    effectiveNativeToolCall: { toolName: "Read", args: {} },
  }, undefined), undefined)
})

test("the pending calls together admit the names they were allowed", () => {
  const contracts: PendingToolExecutionContract[] = [
    { toolCallId: "call-1", outerToolName: "Read", toolIdentifier: "read", isDynamic: false, allowedToolNames: ["Read"] },
    { toolCallId: "call-2", outerToolName: "CallMcpTool", toolIdentifier: "call_mcp_tool", isDynamic: true, allowedToolNames: ["CallMcpTool"], effectiveToolName: "Write", effectiveToolIdentifier: "write" },
  ]
  const admission = collectPendingToolAdmission({ contracts })
  assert.deepEqual([...admission.allowedToolNames ?? []].sort(), ["CallMcpTool", "Read"])
  assert.deepEqual([...admission.admittedEffectiveToolNames].sort(), ["CallMcpTool", "Read", "Write"])
})

test("an inner tool whose namespace call was not allowed is not admitted", () => {
  // The contract names an inner tool, but its own call was not among the allowed names.
  const admission = collectPendingToolAdmission({
    contracts: [{
      toolCallId: "call-1",
      outerToolName: "CallMcpTool",
      toolIdentifier: "call_mcp_tool",
      isDynamic: true,
      allowedToolNames: ["Read"],
      effectiveToolName: "Write",
      effectiveToolIdentifier: "write",
    }],
  })
  assert.deepEqual([...admission.allowedToolNames ?? []], ["Read"])
  // The outer call is admitted because it was made; the inner tool is not, because its call was not allowed.
  assert.deepEqual([...admission.admittedEffectiveToolNames], ["CallMcpTool"])
})

test("nothing pending admits nothing", () => {
  const admission = collectPendingToolAdmission({ contracts: [] })
  assert.equal(admission.allowedToolNames, undefined)
  assert.deepEqual([...admission.admittedEffectiveToolNames], [])
})

// ---------------------------------------------------------------------------------------------
// replaying a call
// ---------------------------------------------------------------------------------------------

test("a replayed call resolves the way it was admitted to", () => {
  const contract = build({
    toolCallId: "call-2",
    toolName: "CallMcpTool",
    args: { namespace: DYNAMIC_TOOLS_NAMESPACE, toolName: "Read", arguments: '{"path":"/a"}' },
  })
  const descriptor = resolveDescriptorForPendingToolCall({
    toolCallId: "call-2",
    toolName: "CallMcpTool",
    args: { namespace: DYNAMIC_TOOLS_NAMESPACE, toolName: "Read", arguments: '{"path":"/a"}' },
    contract,
    toolExecutionSet: executionSet(tools),
  })
  assert.deepEqual(descriptor.effectiveNativeToolCall, { toolName: "Read", args: { path: "/a" } })
})

test("a replayed call with no contract resolves the way the session looks now", () => {
  // The session no longer has the inner tool, and nothing remembers it ever had it.
  const descriptor = resolveDescriptorForPendingToolCall({
    toolCallId: "call-2",
    toolName: "CallMcpTool",
    args: { namespace: DYNAMIC_TOOLS_NAMESPACE, toolName: "Read", arguments: '{"path":"/a"}' },
    toolExecutionSet: executionSet([fakeTool("CallMcpTool", "call_mcp_tool", { dynamicToolMetaRole: "invocation" })]),
  })
  assert.equal(descriptor.effectiveNativeToolCall, undefined)
})

test("a contract naming an inner tool resolves it even after the session lost it", () => {
  // That is what the contract is for: the call is replayed as it was admitted, not as the session now looks.
  const contract = build({
    toolCallId: "call-2",
    toolName: "CallMcpTool",
    args: { namespace: DYNAMIC_TOOLS_NAMESPACE, toolName: "Read", arguments: '{"path":"/a"}' },
  })
  const descriptor = resolveDescriptorForPendingToolCall({
    toolCallId: "call-2",
    toolName: "CallMcpTool",
    args: { namespace: DYNAMIC_TOOLS_NAMESPACE, toolName: "Read", arguments: '{"path":"/a"}' },
    contract,
    toolExecutionSet: executionSet([fakeTool("CallMcpTool", "call_mcp_tool", { dynamicToolMetaRole: "invocation" })]),
  })
  assert.deepEqual(descriptor.effectiveNativeToolCall, { toolName: "Read", args: { path: "/a" } })
})

test("a replayed call with no contract resolves from the session", () => {
  const descriptor = resolveDescriptorForPendingToolCall({
    toolCallId: "call-1",
    toolName: "Read",
    args: { path: "/a" },
    toolExecutionSet: executionSet(tools),
  })
  assert.equal(descriptor.toolName, "Read")
  assert.deepEqual(descriptor.args, { path: "/a" })
})

test("a call that is still the call that was admitted passes its check", () => {
  const contract = build()
  const descriptor = resolveDescriptorForPendingToolCall({
    toolCallId: "call-1",
    toolName: "Read",
    args: { path: "/a" },
    contract,
    toolExecutionSet: executionSet(tools),
  })
  assert.deepEqual(
    validatePendingToolContractIdentity({
      contract,
      descriptor,
      tool: fakeTool("Read", "read"),
      directDynamicToolNames: new Set(),
    }),
    { ok: true },
  )
})

test("a call whose inner tool did not resolve is refused", () => {
  const contract = build({
    toolCallId: "call-2",
    toolName: "CallMcpTool",
    args: { namespace: DYNAMIC_TOOLS_NAMESPACE, toolName: "Read", arguments: '{"path":"/a"}' },
  })
  // A descriptor that resolved no inner tool while the contract names one cannot be the admitted call.
  const descriptor = { toolCallId: "call-2", toolName: "CallMcpTool", args: {} }
  const verdict = validatePendingToolContractIdentity({
    contract,
    descriptor,
    tool: fakeTool("CallMcpTool", "call_mcp_tool"),
    directDynamicToolNames: new Set(),
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.ok === false ? verdict.reason : "", /expected effective tool Read, but none resolved/)
})

test("a call that would now run a different tool is refused", () => {
  const contract = build({ toolName: "Read" })
  const descriptor = resolveDescriptorForPendingToolCall({
    toolCallId: "call-1",
    toolName: "Read",
    args: { path: "/a" },
    contract,
    toolExecutionSet: executionSet(tools),
  })
  // The tool under that name is now a different one, which is what the check exists to catch.
  const verdict = validatePendingToolContractIdentity({
    contract,
    descriptor,
    tool: fakeTool("Read", "something_else"),
    directDynamicToolNames: new Set(),
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.ok === false ? verdict.reason : "", /expected read, got/)
})

test("a refused call is answered with the reason in a tool result", () => {
  const result = createPendingToolContractMismatchResult(
    { toolCallId: "call-1", toolName: "Read", args: {} },
    "the tool changed",
  )
  assert.equal(result.role, "tool")
  assert.equal(result.id, "call-1")
  const content = result.content as Array<Record<string, unknown>>
  assert.equal(content[0]?.type, "tool-result")
  assert.equal(content[0]?.toolCallId, "call-1")
  assert.equal(content[0]?.toolName, "Read")
  assert.equal(content[0]?.result, "the tool changed")
})
