import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { turnMcpExecutorPortFromInterop, turnMcpResourceImplementationFromInterop } from "../../source/adapters/interop/mcp/turn-mcp-executor-adapter.ts";
import { createContext } from "../../source/packages/context/context.ts";
import { createTurnMcpExecutorGuard, wrapTurnShellExecutorForAudit } from "../../source/host/runner/turn-agent-composition.ts";
import { requestIdKey } from "../../source/adapters/interop/chat-inference-proto/client.ts";

describe("turn MCP executor port", () => {
  it("projects wire identity, observes the request, emits one auth card, and keeps the encoded reply", async () => {
    const calls: unknown[] = [];
    const cards: unknown[] = [];
    const observations: unknown[] = [];
    const request = { providerIdentifier: "calendar", serverIdentifier: "srv-1", toolCallId: "call-1", opaqueArgs: { eventId: "e1" } };
    const rawReplies = [
      { result: { case: "error", value: { error: "needs auth" } } },
      { result: { case: "error", value: { error: "still needs auth" } } },
    ];
    let requestIndex = 0;
    const executor = turnMcpExecutorPortFromInterop({
      async execute(context: unknown, args: unknown, options: unknown) {
        calls.push([context, args, options]);
        return rawReplies[requestIndex++];
      },
    });
    const guarded = createTurnMcpExecutorGuard({
      isSubagentRunner: false,
      assertNoPendingApproval: () => calls.push("approval-check"),
      execute: executor.execute,
      beginObservation: (args) => {
        observations.push(args);
        return (errorClass) => observations.push(errorClass);
      },
      boundedConnectorTag: (providerId) => `tag:${providerId}`,
      mcpErrorClassOf: () => "transport-error",
      takeMcpExecErrorClass: () => "mcp-error",
      resolveNeedsAuthSlot: async (providerId) => providerId === "calendar" ? { serverName: "Calendar", serverId: "server-1" } : null,
      emitConnectorCard: (event) => cards.push(event),
      reportDiagnostic: (event) => calls.push(event),
      errorLogTag: () => "unknown",
    });
    const resource = turnMcpResourceImplementationFromInterop((context, call, options) => guarded.execute(context as never, call, options as never));
    const context = createContext().with(requestIdKey, "request-1");
    const options = { trace: "kept" };

    const first = await resource.execute(context, request, options) as { result: { value: { error: string } } };
    const second = await resource.execute(context, request, options) as { result: { value: { error: string } } };
    assert.equal(first, rawReplies[0]);
    assert.equal(second, rawReplies[1]);
    assert.equal(first.result.value.error.includes("end your turn"), true);
    assert.equal(second.result.value.error, "still needs auth");
    assert.deepEqual(cards, [{ connector: "Calendar", serverId: "server-1", variant: "connect" }]);
    assert.deepEqual(calls.filter((entry) => Array.isArray(entry)).map((entry) => (entry as unknown[])[1]), [request, request]);
    assert.deepEqual(observations, [
      { toolCallId: "call-1", connector: "tag:calendar", requestId: "request-1" },
      "mcp-error",
      { toolCallId: "call-1", connector: "tag:calendar", requestId: "request-1" },
      "mcp-error",
    ]);
  });

  it("uses the server identity when a provider identifier is empty and tags executor failures", async () => {
    const observations: unknown[] = [];
    const executor = turnMcpExecutorPortFromInterop({ async execute() { throw new Error("offline"); } });
    const guarded = createTurnMcpExecutorGuard({
      isSubagentRunner: true,
      assertNoPendingApproval() {},
      execute: executor.execute,
      beginObservation: (args) => { observations.push(args); return (errorClass) => observations.push(errorClass); },
      boundedConnectorTag: (providerId) => `tag:${providerId}`,
      mcpErrorClassOf: () => "offline-error",
      takeMcpExecErrorClass: () => undefined,
      emitConnectorCard() {},
      reportDiagnostic() {},
      errorLogTag: () => "unknown",
    });
    const resource = turnMcpResourceImplementationFromInterop((context, call, options) => guarded.execute(context as never, call, options as never));

    await assert.rejects(() => resource.execute(createContext(), { providerIdentifier: "", serverIdentifier: "calendar" }, undefined), { message: "offline" });
    assert.deepEqual(observations, [{ toolCallId: "", connector: "tag:calendar" }, "offline-error"]);
  });
});

describe("turn shell audit port", () => {
  it("checks approval and records command intent before forwarding the opaque request", async () => {
    const calls: unknown[] = [];
    const base = { async execute(context: unknown, args: unknown, options: unknown) { calls.push([context, args, options]); return { case: "success" }; } };
    const executor = wrapTurnShellExecutorForAudit(base, {
      assertNoPendingApproval: () => calls.push("approval-check"),
      auditShellCommand: (kind, command, surface) => calls.push([kind, command, surface]),
    }, "background");
    const context = { ctx: true };
    const args = { command: "git push", workingDirectory: "/repo", opaque: { retained: true } };
    const options = { execId: "exec-1" };

    assert.deepEqual(await executor.execute(context, args, options), { case: "success" });
    assert.deepEqual(calls, ["approval-check", ["background", "git push", "user_machine"], [context, args, options]]);
  });

  it("refuses an executor request with no command to audit", () => {
    const executor = wrapTurnShellExecutorForAudit({ execute() { return "unreachable"; } }, {
      assertNoPendingApproval() {},
      auditShellCommand() {},
    }, "foreground");
    assert.throws(() => executor.execute({}, {}, undefined), /shell executor request is missing a command/);
  });
});
