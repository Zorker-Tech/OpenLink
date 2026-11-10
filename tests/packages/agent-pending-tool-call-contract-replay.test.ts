import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildPendingToolExecutionContract,
  collectPendingToolAdmission,
  createPendingToolContractMismatchResult,
  enrichPendingToolCallJson,
  getAdmittedEffectiveToolName,
  readPendingToolExecutionContracts,
  resolveDescriptorForPendingToolCall,
  validatePendingToolContractIdentity,
} from "../../source/packages/agent/pending-tool-call-contract.ts";
import { DYNAMIC_TOOLS_NAMESPACE } from "../../source/packages/agent-exec/mcp-operations.ts";

const fakeTool = (name: string, toolIdentifier: string, extra: Record<string, unknown> = {}) => ({ name, toolIdentifier, parameters: {}, ...extra });
const executionSet = (toolsNow: any[]) => ({ modelVisibleTools: toolsNow, additionalExecutableTools: [] }) as never;
const resolveIdentity = ({ toolName }: { toolName: string; args: unknown }) =>
  toolName === "Read"
    ? { toolIdentifier: "read", isDynamic: false }
    : toolName === "CallMcpTool"
      ? { toolIdentifier: "call_mcp_tool", isDynamic: true }
      : undefined;
const tools = [fakeTool("Read", "read"), fakeTool("CallMcpTool", "call_mcp_tool", { dynamicToolMetaRole: "invocation" })];
const build = (input: { toolCallId?: string; toolName?: string; args?: unknown; allowed?: string[] } = {}) =>
  buildPendingToolExecutionContract({
    toolCallId: input.toolCallId ?? "call-1",
    toolName: input.toolName ?? "Read",
    args: input.args ?? { path: "/a" },
    resolveIdentity,
    toolExecutionSet: executionSet(tools),
    allowedToolNames: input.allowed ?? ["Read", "CallMcpTool"],
  });

describe("the contracts a pending tool call carries", () => {
  it("reads back only whole contracts stored under their own key", () => {
    const whole = build();
    const message = { providerOptions: { slate: { pendingToolExecutionContracts: {
      "call-1": whole,
      "call-2": whole,
      "call-3": { toolCallId: "call-3", outerToolName: "Read" },
      "call-4": { toolCallId: "call-4", outerToolName: "Read", toolIdentifier: "read", isDynamic: "yes", allowedToolNames: [] },
    } } } };
    const contracts = readPendingToolExecutionContracts(message as never);
    assert.deepEqual([...contracts.keys()], ["call-1"]);
    assert.deepEqual(readPendingToolExecutionContracts({} as never).size, 0);
  });

  it("writes down the inner tool a dynamic call would run", () => {
    const contract = build({ toolName: "CallMcpTool", args: { namespace: DYNAMIC_TOOLS_NAMESPACE, toolName: "Read", arguments: '{"path":"/a"}' } });
    assert.deepEqual([contract.effectiveToolName, contract.effectiveToolIdentifier, contract.isDynamic], ["Read", "read", true]);
    const unknown = build({ toolName: "SomethingNew", args: {} });
    assert.deepEqual([unknown.toolIdentifier, unknown.isDynamic], ["unknown", false]);
  });

  it("writes the contracts onto the pending message and keeps the first start time", () => {
    const pending = JSON.stringify({ role: "user", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "Read", args: { path: "/a" } }] });
    const enriched = JSON.parse(enrichPendingToolCallJson(pending, { resolveIdentity, toolExecutionSet: executionSet(tools), allowedToolNames: ["Read"], pendingToolCallStartedAtMs: 1_000 }));
    assert.equal(enriched.providerOptions.slate.pendingToolCallStartedAtMs, 1_000);
    assert.equal(enriched.providerOptions.slate.pendingToolExecutionContracts["call-1"].toolIdentifier, "read");
    const alreadyStarted = JSON.parse(enrichPendingToolCallJson(JSON.stringify({ role: "user", content: [], providerOptions: { slate: { pendingToolCallStartedAtMs: 500 } } }), { resolveIdentity, toolExecutionSet: executionSet(tools), allowedToolNames: [], pendingToolCallStartedAtMs: 1_000 }));
    assert.equal(alreadyStarted.providerOptions.slate.pendingToolCallStartedAtMs, 500, "the first start time is the truth");
    assert.equal(enrichPendingToolCallJson("not json", { resolveIdentity, toolExecutionSet: executionSet(tools), allowedToolNames: [] }), "not json");
  });
});

describe("admitting and replaying a pending call", () => {
  it("admits the outer names and the inner tools their namespace calls allow", () => {
    const plain = build();
    const dynamic = build({ toolName: "CallMcpTool", args: { namespace: DYNAMIC_TOOLS_NAMESPACE, toolName: "Read", arguments: "{}" } });
    const admission = collectPendingToolAdmission({ contracts: [plain, dynamic] });
    assert.deepEqual([...(admission.allowedToolNames ?? [])].sort(), ["CallMcpTool", "Read"]);
    assert.deepEqual([...admission.admittedEffectiveToolNames].sort(), ["CallMcpTool", "Read"]);
    assert.equal(getAdmittedEffectiveToolName({ toolCallId: "c", toolName: "CallMcpTool", args: {}, effectiveNativeToolCall: { toolName: "Read", args: {} } } as never, new Set(["CallMcpTool"])), "Read");
    assert.equal(getAdmittedEffectiveToolName({ toolCallId: "c", toolName: "CallMcpTool", args: {}, effectiveNativeToolCall: { toolName: "Read", args: {} } } as never, new Set()), undefined);
  });

  it("replays a dynamic call from its stored inner tool", () => {
    const dynamic = build({ toolName: "CallMcpTool", args: { namespace: DYNAMIC_TOOLS_NAMESPACE, toolName: "Read", arguments: "{}" } });
    const descriptor = resolveDescriptorForPendingToolCall({ toolCallId: "call-1", toolName: "CallMcpTool", args: { namespace: DYNAMIC_TOOLS_NAMESPACE, toolName: "Read", arguments: '{"path":"/b"}' }, contract: dynamic, toolExecutionSet: executionSet(tools) });
    assert.deepEqual(descriptor.effectiveNativeToolCall, { toolName: "Read", args: { path: "/b" } });
    const mismatchedNamespace = resolveDescriptorForPendingToolCall({ toolCallId: "call-1", toolName: "Read", args: { path: "/a" }, contract: dynamic, toolExecutionSet: executionSet(tools) });
    assert.equal(mismatchedNamespace.effectiveNativeToolCall, undefined);
  });

  it("answers a changed tool with the mismatch instead of running it", () => {
    const contract = build();
    assert.deepEqual(validatePendingToolContractIdentity({ contract, descriptor: { toolCallId: "call-1", toolName: "Read", args: { path: "/a" } } as never, tool: fakeTool("Read", "read"), directDynamicToolNames: new Set() }), { ok: true });
    const changed = validatePendingToolContractIdentity({ contract, descriptor: { toolCallId: "call-1", toolName: "Read", args: { path: "/a" } } as never, tool: fakeTool("Write", "write"), directDynamicToolNames: new Set() });
    assert.deepEqual(changed, { ok: false, reason: "Pending tool contract mismatch for Read: expected read, got write" });
    const dynamic = build({ toolName: "CallMcpTool", args: { namespace: DYNAMIC_TOOLS_NAMESPACE, toolName: "Read", arguments: "{}" } });
    const vanished = validatePendingToolContractIdentity({ contract: dynamic, descriptor: { toolCallId: "call-1", toolName: "CallMcpTool", args: {} } as never, tool: fakeTool("CallMcpTool", "call_mcp_tool"), directDynamicToolNames: new Set() });
    assert.deepEqual(vanished, { ok: false, reason: "Pending tool contract mismatch for CallMcpTool: expected effective tool Read, but none resolved" });
    assert.deepEqual(createPendingToolContractMismatchResult({ toolCallId: "call-1", toolName: "Read", args: {} } as never, "changed"), { role: "tool", id: "call-1", content: [{ type: "tool-result", toolName: "Read", toolCallId: "call-1", result: "changed" }] });
  });
});