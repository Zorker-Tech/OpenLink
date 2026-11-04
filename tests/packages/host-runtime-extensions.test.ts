/**
 * The host's runtime pieces, ninth group: the settings service as an extension, running an MCP tool on a box,
 * the host's own machine behind the local-exec bridge, the acknowledgements a transcript still owes, and
 * sharing a room with another user's computer.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { Value } from "@bufbuild/protobuf";

import { mcpExecutorResource, mcpStateExecutorResource } from "../../source/packages/agent-exec/mcp-operations.ts";
import { createContext } from "../../source/packages/context/context.ts";
import { McpArgs, McpResult, McpStateError, McpStateExecArgs, McpStateExecResult, McpStateServer, McpStateSuccess, McpSuccess } from "../../source/adapters/interop/proto/generated/agent/v1/mcp_exec_pb.ts";
import { McpToolDefinition } from "../../source/adapters/interop/proto/generated/agent/v1/mcp_pb.ts";
import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";
import { createDeadlinePolicy, createExpiryPolicy, createIdleWatchdogPolicy, createPollingPolicy, type Clock } from "../../source/host/extensions/scheduling.ts";
import { createBridgeUserComputers, FALLBACK_TERMINALS_FOLDER, GatewayLocalExecBox, type GatewayExecControl, type GatewayLocalExecCodec, type GatewayLocalExecManager } from "../../source/host/local-exec/gateway-local-exec-slate-box.ts";
import { SlateLocalExecBridge, type LocalExecBridgeFrame } from "../../source/host/local-exec/local-exec-bridge.ts";
import { SlateLocalExecError } from "../../source/host/local-exec/local-exec-error.ts";
import { BoxMcpExecError, createBoxSlateMcpExec, errorLabel } from "../../source/adapters/interop/agent/box-mcp-exec-adapter.ts";
import { SELF_IDENTITY_RETRY_MS, SlateXuserSharingService, STATE_RECONCILE_INTERVAL_MS } from "../../source/host/rooms/xuser-sharing-service.ts";
import { settingsExtension } from "../../source/host/settings/extension.ts";
import { SettingsService } from "../../source/host/settings/settings-service.ts";
import { coerceObligation, finiteNumber, parseAckObligationsFile, SlateAckObligationStore } from "../../source/host/transcript/slate-ack-obligation-store.ts";
import { EMPTY_SLATE_SHARING_STATE } from "../../source/shared/agents/sharing.ts";
import { DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES } from "../../source/shared/local-exec-gateway.ts";
import { SlateLocalToolPermissionDeniedError, slateLocalToolScopeKey } from "../../source/shared/local-tool-permission-machinery.ts";
import type { SharingDependencies, SharingManager } from "../../source/host/rooms/xuser-sharing-service.ts";
import type { Context } from "../../source/packages/context/context.ts";

/** A clock the test moves itself, so a poll and an expiry happen without waiting on real time. */
function testClock(start = 1_000_000): Clock & { advance(ms: number): Promise<void> } {
  let current = start;
  const scheduled: Array<{ at: number; callback: () => void; disposed: boolean }> = [];
  return {
    now: () => current,
    monotonicNow: () => current,
    schedule(delayMs, callback) {
      const entry = { at: current + delayMs, callback, disposed: false };
      scheduled.push(entry);
      return { dispose() { entry.disposed = true; } };
    },
    async advance(ms) {
      current += ms;
      for (const entry of [...scheduled]) if (!entry.disposed && entry.at <= current) { entry.disposed = true; await entry.callback(); }
    },
  };
}

/** A turn of the event loop, which is what a call that was started and not awaited needs. */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

describe("the settings service as an extension", () => {
  it("registers itself under its own id, with no dependencies, and starts the service", async () => {
    assert.equal(settingsExtension.kind, "host-extension");
    assert.equal(settingsExtension.id, HostExtensions.Settings);
    assert.equal(settingsExtension.id, "settings");
    assert.equal(settingsExtension.dependencies.length, 0);
    assert.equal(Object.isFrozen(settingsExtension), true);
    const api = await settingsExtension.start({ deps: {}, host: undefined, onStop: () => {} });
    assert.equal(api instanceof SettingsService, true);
    assert.equal(typeof api.getHostSettings, "function");
  });
});

describe("running an MCP tool on a box", () => {
  const accessor = (execute: (resource: unknown, args: unknown) => Promise<unknown>) => ({ get: (resource: unknown) => ({ execute: (ctx: unknown, args: unknown) => execute(resource, args) }) });
  const server = (fields: { serverIdentifier: string; status?: string; errorMessage?: string; tools?: McpToolDefinition[] }) => new McpStateServer({ serverName: fields.serverIdentifier, ...fields });
  const success = (servers: McpStateServer[]) => new McpStateExecResult({ result: { case: "success", value: new McpStateSuccess({ servers }) } });

  it("loads the box's servers, and reports a box that cannot run MCP at all", async () => {
    const loaded: string[] = [];
    const box = { loadMcpServers: async (_ctx: unknown, configJson: string) => { loaded.push(configJson); }, mcpResourceAccessor: async () => accessor(async () => success([])) };
    const exec = createBoxSlateMcpExec(box);
    assert.equal(await exec.loadServers('{"mcpServers":{}}'), undefined);
    assert.deepEqual(loaded, ['{"mcpServers":{}}']);
    const incapable = createBoxSlateMcpExec({});
    await incapable.loadServers("{}").then(() => assert.fail("a box without MCP loaded servers"), (error: Error) => assert.equal(error.name, "BoxMcpUnsupportedError"));
    await incapable.listTools([]).then(() => assert.fail("a box without MCP listed tools"), (error: Error) => assert.equal(error.name, "BoxMcpUnsupportedError"));
  });

  it("hands the tool layer the servers the box reported, with what each server says about itself", async () => {
    const asked: unknown[] = [];
    const tools = [
      new McpToolDefinition({ name: "search", providerIdentifier: "provider-one", toolName: "search_the_web", description: "looks things up", inputSchema: Value.fromJson({ type: "object" }) }),
      new McpToolDefinition({ name: "quiet", providerIdentifier: "provider-one", toolName: "quiet_tool" }),
    ];
    const exec = createBoxSlateMcpExec({
      mcpResourceAccessor: async () => accessor(async (resource, args) => {
        assert.equal(resource, mcpStateExecutorResource);
        asked.push(args);
        return success([
          server({ serverIdentifier: "server-a", status: "connected", tools }),
          server({ serverIdentifier: "server-b", errorMessage: "no command configured" }),
          server({ serverIdentifier: "server-c" }),
        ]);
      }),
    });
    const servers = await exec.listTools([]);
    assert.deepEqual(asked, [new McpStateExecArgs({ serverIdentifiers: [], kickOnly: false })]);
    assert.deepEqual(servers.map((item) => item.serverIdentifier), ["server-a", "server-b", "server-c"]);
    // A server that says nothing about its state is taken as connected, and one that names a problem carries it.
    assert.deepEqual(servers.map((item) => item.status), ["connected", "connected", "connected"]);
    assert.equal(servers[1]?.statusDetail, "no command configured");
    assert.equal(servers[2]?.statusDetail, undefined);
    assert.deepEqual(servers[0]?.tools, [
      { name: "search", providerIdentifier: "provider-one", toolName: "search_the_web", clientKey: "server-a", description: "looks things up", inputSchema: { type: "object" } },
      // No description and no schema means the tool carries neither, rather than carrying empty ones.
      { name: "quiet", providerIdentifier: "provider-one", toolName: "quiet_tool", clientKey: "server-a" },
    ]);
    assert.equal(servers[0]?.toolCount, 2);
    assert.deepEqual(await exec.listTools(["server-b"]), [servers[1]]);
    await exec.listTools(["server-c"], { kickOnly: true });
    assert.deepEqual(asked.at(-1), new McpStateExecArgs({ serverIdentifiers: ["server-c"], kickOnly: true }));
  });

  it("reports a box that answered discovery with a failure instead of an empty list of servers", async () => {
    const failing = createBoxSlateMcpExec({ mcpResourceAccessor: async () => accessor(async () => new McpStateExecResult({ result: { case: "error", value: new McpStateError({ error: "no bridge" }) } })) });
    await failing.listTools([]).then(() => assert.fail("a failed discovery was taken as an answer"), (error: Error) => {
      assert.equal(error instanceof BoxMcpExecError, true);
      assert.equal(error.message, "Box MCP tool discovery failed: error");
    });
    const silent = createBoxSlateMcpExec({ mcpResourceAccessor: async () => accessor(async () => new McpStateExecResult({})) });
    await silent.listTools([]).then(() => assert.fail("an empty result was taken as an answer"), (error: Error) => assert.equal(error.message, "Box MCP tool discovery failed: empty result"));
  });

  it("carries a tool call to the box, and turns one it could not answer into an answer that says so", async () => {
    const answer = new McpResult({ result: { case: "success", value: new McpSuccess({ content: [] }) } });
    const exec = createBoxSlateMcpExec({
      mcpResourceAccessor: async () => accessor(async (resource, args) => {
        assert.equal(resource, mcpExecutorResource);
        if ((args as McpArgs).name === "explode") throw new Error("bridge down");
        return answer;
      }),
    });
    assert.equal(await exec.executeTool(new McpArgs({ name: "search", toolCallId: "call-1" })), answer);
    const failed = await exec.executeTool(new McpArgs({ name: "explode", toolCallId: "call-2" }));
    assert.equal(failed.result.case, "error");
    assert.equal(failed.result.case === "error" ? failed.result.value.error : "", 'Box MCP execution failed for "explode": bridge down');
  });

  it("labels an error by its message, its name, or what it is", () => {
    assert.equal(errorLabel(new Error("the bridge is down")), "the bridge is down");
    assert.equal(errorLabel(new Error("")), "Error");
    assert.equal(errorLabel("plain text"), "plain text");
    assert.equal(errorLabel({ code: 7 }), "[object Object]");
    const error = new BoxMcpExecError("this box cannot run MCP");
    assert.equal(error.name, "BoxMcpExecError");
    assert.equal(error instanceof Error, true);
  });
});

describe("the host's own machine behind the local-exec bridge", () => {
  function hostMachine(options: { blocked?: string; requiresApproval?: boolean; maxFileBytes?: number } = {}) {
    let ids = 0;
    const clock = testClock();
    const sent: LocalExecBridgeFrame[] = [];
    const bridge = new SlateLocalExecBridge({ clock, responseWatchdog: createIdleWatchdogPolicy(clock, { name: "response", idleMs: 10_000 }), blockedReason: () => undefined, randomId: () => `request-${++ids}` });
    const approvals: Array<{ action: string; target: string; resourcePath?: string }> = [];
    const gate = {
      blockedReason: () => options.blocked,
      requiresApproval: () => options.requiresApproval ?? true,
      authorize: async (_scope: unknown, request: { action: string; target: string; resourcePath?: string }) => {
        approvals.push(request);
        return { allowed: true, reason: "", approvalId: "approval-1" };
      },
    };
    type Client = unknown;
    const codec: GatewayLocalExecCodec<Client, GatewayLocalExecManager<Client>> = {
      decodeClient: (json) => json,
      decodeControl: (json) => json as GatewayExecControl,
      createRemoteAccessor: (manager) => manager,
    };
    const box = new GatewayLocalExecBox<Client, GatewayLocalExecManager<Client>>(bridge, {
      gate,
      codec,
      ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
    });
    const detach = bridge.registerProvider((frame) => sent.push(frame));
    const speak = () => bridge.submitResponses({ frames: [{ kind: "hello", localRoot: "/home/user", terminalsFolder: "/home/user/terminals", computerId: "computer-1", label: "My laptop" }] });
    const last = (kind: string): LocalExecBridgeFrame => { const frame = [...sent].reverse().find((item) => item.kind === kind); assert.ok(frame !== undefined, `no ${kind} frame was sent`); return frame; };
    speak();
    return { clock, sent, bridge, box, approvals, detach, speak, last, gate };
  }

  it("says whether a machine is there at all, and which folder its terminals live in", async () => {
    const { box, bridge, detach, last, sent } = hostMachine();
    assert.equal(FALLBACK_TERMINALS_FOLDER, "terminals");
    assert.equal(bridge.hasProvider(), true);
    assert.equal(box.terminalsFolder(), "/home/user/terminals");
    assert.equal(sent[0]?.kind, "welcome");
    assert.deepEqual(await box.ensureReady(createContext(), "agent-1").then((ready) => ({ vncUrl: ready.vncUrl, terminalsFolder: ready.terminalsFolder })), { vncUrl: "", terminalsFolder: "/home/user/terminals" });
    assert.deepEqual(await box.listBoxes(), []);
    assert.equal(await box.hibernate(createContext(), "agent-1"), undefined);
    assert.equal(await box.runState(createContext(), "agent-1"), "running");
    // With nothing registered there is no machine to run on, and the folder falls back to the platform's own name.
    detach();
    assert.equal(bridge.hasProvider(), false);
    assert.equal(box.terminalsFolder(), FALLBACK_TERMINALS_FOLDER);
    assert.equal(await box.runState(createContext(), "agent-1"), "absent");
    assert.equal(last("welcome").providerId, "request-1");
  });

  it("carries a file to and from the machine with the approval the user gave", async () => {
    const { box, approvals, last, bridge } = hostMachine();
    const context = createContext().withName("upload");
    const upload = box.uploadFile(context, "agent-1", "/home/user/note.txt", new TextEncoder().encode("hello"));
    await settle();
    const uploadFrame = last("upload");
    assert.deepEqual({ path: uploadFrame.path, bytes: Buffer.from(String(uploadFrame.bytesBase64), "base64").toString(), approvalId: uploadFrame.approvalId }, { path: "/home/user/note.txt", bytes: "hello", approvalId: "approval-1" });
    bridge.submitResponses({ frames: [{ kind: "file", requestId: String(uploadFrame.requestId) }] });
    assert.equal(await upload, undefined);

    const download = box.downloadFile(context, "agent-1", "/home/user/note.txt");
    await settle();
    const downloadFrame = last("download");
    assert.deepEqual({ path: downloadFrame.path, approvalId: downloadFrame.approvalId }, { path: "/home/user/note.txt", approvalId: "approval-1" });
    bridge.submitResponses({ frames: [{ kind: "file", requestId: String(downloadFrame.requestId), bytesBase64: Buffer.from("bytes!").toString("base64") }] });
    assert.equal(Buffer.from(await download).toString(), "bytes!");
    // Both read and write went to the user for approval, as the action they are on the machine.
    assert.deepEqual(approvals.map((request) => [request.action, request.target]), [["write-file", "/home/user/note.txt"], ["read-file", "/home/user/note.txt"]]);
  });

  it("allows a file exactly at the configured byte limit", async () => {
    const { box, bridge, last } = hostMachine({ maxFileBytes: 3 });
    const upload = box.uploadFile(createContext().withName("upload"), "agent-1", "/home/user/tiny.bin", new Uint8Array([1, 2, 3]));
    await settle();
    const frame = last("upload");
    assert.equal(Buffer.from(String(frame.bytesBase64), "base64").byteLength, 3);
    bridge.submitResponses({ frames: [{ kind: "file", requestId: String(frame.requestId) }] });
    await upload;
  });

  it("refuses a file too large to move, a machine that is not there, and a gate that is closed", async () => {
    const { box, last, bridge, sent } = hostMachine();
    const context = createContext().withName("upload");
    await box.uploadFile(context, "agent-1", "/home/user/big.bin", new Uint8Array(DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES + 1)).then(
      () => assert.fail("a file past the limit was moved"),
      (error: SlateLocalExecError) => assert.equal(error instanceof SlateLocalExecError, true),
    );
    const failing = box.downloadFile(context, "agent-1", "/home/user/gone.txt");
    await settle();
    bridge.submitResponses({ frames: [{ kind: "file-error", requestId: String(last("download").requestId), error: "not found" }] });
    await failing.then(() => assert.fail("a file the machine refused was taken as read"), (error: SlateLocalExecError) => { assert.equal(error instanceof SlateLocalExecError, true); assert.equal(error.message, "not found"); });

    const elsewhere = new GatewayLocalExecBox(bridge, { gate: { blockedReason: () => undefined, requiresApproval: () => true, authorize: async () => ({ allowed: true, reason: "" }) }, codec: { decodeClient: (json) => json, decodeControl: (json) => json as GatewayExecControl, createRemoteAccessor: (manager) => manager }, computerId: "another-computer" });
    await elsewhere.uploadFile(context, "agent-1", "/x.txt", new Uint8Array([1])).then(() => assert.fail("a file went to a machine that is not connected"), (error: SlateLocalExecError) => assert.equal(error instanceof SlateLocalExecError, true));

    const closed = new GatewayLocalExecBox(bridge, { gate: { blockedReason: () => "Local tools are turned off.", requiresApproval: () => true, authorize: async () => ({ allowed: true, reason: "" }) }, codec: { decodeClient: (json) => json, decodeControl: (json) => json as GatewayExecControl, createRemoteAccessor: (manager) => manager } });
    await closed.uploadFile(context, "agent-1", "/x.txt", new Uint8Array([1])).then(() => assert.fail("a closed gate let a file through"), (error: Error) => { assert.equal(error.name, "SlateLocalToolPermissionDeniedError"); assert.equal((error as Error & { reason: string }).reason, "Local tools are turned off."); });
    const ready = await closed.ensureReady(context, "agent-1");
    const commandRun = (async () => {
      for await (const _client of ready.remoteAccessor.createExecInstance(context, () => shellArgs)) { /* nothing */ }
    })();
    const commandOutcome = commandRun.then(() => ({ rejected: false as const }), (error: unknown) => ({ rejected: true as const, error }));
    await settle();
    const execFrame = sent.find((frame) => frame.kind === "exec");
    if (execFrame !== undefined) {
      bridge.submitResponses({ frames: [{ kind: "control", requestId: String(execFrame.requestId), message: { case: "streamClose" } }] });
    }
    const refusal = await commandOutcome;
    assert.equal(refusal.rejected, true);
    assert.equal(refusal.rejected && (refusal.error as Error).name, "SlateLocalToolPermissionDeniedError");
  });

  /** The message a caller serializes for the machine, as the exec manager takes it. */
  type ExecArgs = { message: { case: string; value: Record<string, unknown> }; toJson(): unknown };
  const shellArgs: ExecArgs = { message: { case: "shellStreamArgs", value: { command: "ls -la" } }, toJson() { return { message: { case: "shellStreamArgs", value: { command: "ls -la" } } } } };

  async function runCommand(manager: GatewayLocalExecManager<unknown>, context: Context, args: ExecArgs) {
    const seen: unknown[] = [];
    const run = (async () => { for await (const client of manager.createExecInstance(context, () => args)) seen.push(client); })();
    const outcome = run.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
    return { seen, outcome };
  }

  it("carries a command to the machine, asks for it first, and hands every frame of the answer back", async () => {
    const { box, approvals, last, bridge } = hostMachine();
    const context = createContext().withName("exec");
    const ready = await box.ensureReady(context, "agent-1");
    const { seen, outcome } = await runCommand(ready.remoteAccessor, context, shellArgs);
    await settle();
    const frame = last("exec");
    assert.deepEqual({ serverMessage: frame.serverMessage, approvalId: frame.approvalId }, { serverMessage: shellArgs.toJson(), approvalId: "approval-1" });
    assert.deepEqual(approvals.map((request) => request.action), ["run-command"]);
    assert.equal(approvals[0]?.resourcePath, "/home/user/terminals");
    bridge.submitResponses({ frames: [
      { kind: "client", requestId: String(frame.requestId), message: { message: { case: "shellStreamEvent", value: { text: "ok" } } } },
      { kind: "control", requestId: String(frame.requestId), message: { case: "streamClose" } },
    ] });
    assert.deepEqual(await outcome, { ok: true });
    assert.deepEqual(seen, [{ message: { case: "shellStreamEvent", value: { text: "ok" } } }]);
  });

  it("will not carry a request it cannot describe to the user, and carries one that needs no asking about", async () => {
    const undescribable: ExecArgs = { message: { case: "mysteryArgs", value: {} }, toJson() { return { message: { case: "mysteryArgs", value: {} } } } };
    const strict = hostMachine();
    const strictContext = createContext().withName("exec");
    const strictReady = await strict.box.ensureReady(strictContext, "agent-1");
    const sentBefore = strict.sent.length;
    const { outcome } = await runCommand(strictReady.remoteAccessor, strictContext, undescribable);
    assert.equal(strict.sent.length, sentBefore);
    const refused = await outcome;
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false ? (refused.error as Error).name : "", "SlateLocalToolPermissionDeniedError");

    const permissive = hostMachine({ requiresApproval: false });
    const permissiveContext = createContext().withName("exec");
    const permissiveReady = await permissive.box.ensureReady(permissiveContext, "agent-1");
    const ran = await runCommand(permissiveReady.remoteAccessor, permissiveContext, undescribable);
    await settle();
    const frame = permissive.last("exec");
    assert.equal(frame.approvalId, undefined);
    permissive.bridge.submitResponses({ frames: [{ kind: "control", requestId: String(frame.requestId), message: { case: "streamClose" } }] });
    assert.deepEqual(await ran.outcome, { ok: true });
  });

  it("consumes an exec request id before rejecting a malformed message and sends no frame", async () => {
    const { box, bridge, sent } = hostMachine();
    const context = createContext().withName("exec");
    const ready = await box.ensureReady(context, "agent-1");
    const manager = ready.remoteAccessor;
    const requestIds: number[] = [];
    let serialized = 0;
    const malformed: ExecArgs = {
      message: { case: "shellStreamArgs", value: [] as unknown as Record<string, unknown> },
      toJson() { serialized += 1; return {}; },
    };
    const invalid = (async () => {
      for await (const _client of manager.createExecInstance(context, (id) => { requestIds.push(id); return malformed; })) {
        void _client;
      }
    })();
    const invalidOutcome = invalid.then(
      () => ({ rejected: false as const }),
      (error: unknown) => ({ rejected: true as const, error }),
    );
    await settle();
    const invalidFrame = sent.find((frame) => frame.kind === "exec");
    if (invalidFrame !== undefined) {
      bridge.submitResponses({ frames: [{ kind: "control", requestId: String(invalidFrame.requestId), message: { case: "streamClose" } }] });
    }
    const result = await invalidOutcome;
    assert.equal(result.rejected, true);
    assert.equal(result.rejected && result.error instanceof SlateLocalToolPermissionDeniedError, true);
    assert.deepEqual(requestIds, [0]);
    assert.equal(serialized, 0, "an undescribable request is refused before it is serialized for the bridge");
    assert.equal(sent.some((frame) => frame.kind === "exec"), false);

    const followUp = (async () => {
      for await (const _client of manager.createExecInstance(context, (id) => { requestIds.push(id); return shellArgs; })) {
        void _client;
      }
    })();
    await settle();
    const frame = sent.find((item) => item.kind === "exec");
    assert.ok(frame !== undefined);
    assert.deepEqual(requestIds, [0, 1]);
    bridge.submitResponses({ frames: [{ kind: "control", requestId: String(frame.requestId), message: { case: "streamClose" } }] });
    await followUp;
  });

  it("reports a command the machine refused, with the site and the conversation it happened in", async () => {
    const reports: unknown[] = [];
    const clock = testClock();
    const sent: LocalExecBridgeFrame[] = [];
    const bridge = new SlateLocalExecBridge({ clock, responseWatchdog: createIdleWatchdogPolicy(clock, { name: "response", idleMs: 10_000 }), blockedReason: () => undefined, randomId: () => "request-1" });
    const box = new GatewayLocalExecBox(bridge, { gate: { blockedReason: () => undefined, requiresApproval: () => true, authorize: async () => ({ allowed: true, reason: "", approvalId: "approval-1" }) }, codec: { decodeClient: (json) => json, decodeControl: (json) => json as GatewayExecControl, createRemoteAccessor: (manager) => manager }, reportFailure: (report) => reports.push(report) });
    bridge.registerProvider((frame) => sent.push(frame));
    bridge.submitResponses({ frames: [{ kind: "hello", localRoot: "/home/user", terminalsFolder: "/home/user/terminals" }] });
    const context = createContext().withName("exec").with(slateLocalToolScopeKey, { agentId: "agent-9" });
    const ready = await box.ensureReady(context, "agent-9");
    const { outcome } = await runCommand(ready.remoteAccessor, context, shellArgs);
    await settle();
    const frame = sent.find((item) => item.kind === "exec");
    assert.ok(frame !== undefined);
    bridge.submitResponses({ frames: [
      { kind: "control", requestId: String(frame.requestId), message: { case: "throw", error: "command not found", stackTrace: "at sh" } },
      { kind: "control", requestId: String(frame.requestId), message: { case: "streamClose" } },
    ] });
    const settled = await outcome;
    assert.equal(settled.ok, false);
    assert.equal(settled.ok === false ? (settled.error as Error).message : "", "command not found");
    assert.equal(settled.ok === false ? (settled.error as Error).stack : "", "at sh");
    assert.deepEqual(reports, [{ errorClass: "other", site: "exec", conversationId: "agent-9" }]);
  });

  it("lists the computers behind the bridge and resolves one by its id", () => {
    const { bridge, box, gate } = hostMachine();
    const computers = createBridgeUserComputers(bridge, { gate, codec: { decodeClient: (json) => json, decodeControl: (json) => json as GatewayExecControl, createRemoteAccessor: (manager) => manager } });
    assert.deepEqual(computers.list(), [{ id: "computer-1", label: "My laptop", connected: true }]);
    const active = computers.resolve();
    assert.equal(active?.id, "computer-1");
    assert.equal(active?.label, "My laptop");
    assert.equal(active?.box instanceof GatewayLocalExecBox, true);
    assert.equal(active?.box.terminalsFolder(), "/home/user/terminals");
    assert.equal(computers.resolve("computer-1")?.id, "computer-1");
    assert.equal(computers.resolve("missing"), undefined);
    // A box the bridge cannot route never reaches the machine.
    assert.equal(box.terminalsFolder(), "/home/user/terminals");
  });
});

describe("the acknowledgements a transcript still owes", () => {
  const root = () => mkdtempSync(join(tmpdir(), "slate-ack-"));

  it("writes an obligation down, coalesces the next send, and forgets it when it is cleared", () => {
    const store = new SlateAckObligationStore(root());
    assert.equal(store.filePath.endsWith("ack-obligations.json"), true);
    assert.deepEqual(store.list(), []);
    assert.equal(store.get("agent-1"), undefined);
    const first = store.recordSend("agent-1", { atMs: 100 });
    assert.deepEqual(first, { obligation: { agentId: "agent-1", createdAtMs: 100, lastSendAtMs: 100, coalescedCount: 1, redriveAttempts: 0 }, created: true });
    const second = store.recordSend("agent-1", { atMs: 200 });
    assert.deepEqual(second, { obligation: { agentId: "agent-1", createdAtMs: 100, lastSendAtMs: 200, coalescedCount: 2, redriveAttempts: 0 }, created: false });
    // An interrupt and a redrive belong to an obligation that is owed; without one there is nothing to write to.
    assert.equal(store.recordInterrupt("nobody", 5), undefined);
    assert.equal(store.recordRedriveAttempt("nobody"), undefined);
    store.recordInterrupt("agent-1", 250);
    assert.equal(store.get("agent-1")?.lastInterruptAtMs, 250);
    assert.equal(store.recordRedriveAttempt("agent-1")?.redriveAttempts, 1);
    assert.deepEqual(JSON.parse(readFileSync(store.filePath, "utf8")), { version: 1, pending: [{ agentId: "agent-1", createdAtMs: 100, lastSendAtMs: 200, coalescedCount: 2, redriveAttempts: 1, lastInterruptAtMs: 250 }] });
    store.clear("agent-1");
    assert.deepEqual(store.list(), []);
    assert.deepEqual(new SlateAckObligationStore(join(store.filePath, "..")).list(), []);
  });

  it("reads back what it wrote, and nothing at all from a file it cannot make sense of", () => {
    const directory = root();
    const store = new SlateAckObligationStore(directory);
    store.recordSend("agent-1", { atMs: 100 });
    assert.deepEqual(new SlateAckObligationStore(directory).list(), [{ agentId: "agent-1", createdAtMs: 100, lastSendAtMs: 100, coalescedCount: 1, redriveAttempts: 0 }]);
    writeFileSync(store.filePath, "{not json");
    assert.deepEqual(new SlateAckObligationStore(directory).list(), []);
    writeFileSync(store.filePath, JSON.stringify({ pending: "nope" }));
    assert.deepEqual(new SlateAckObligationStore(directory).list(), []);
    assert.deepEqual(parseAckObligationsFile(null), []);
    // An entry that names no agent is dropped rather than kept without one.
    assert.deepEqual(parseAckObligationsFile(JSON.stringify({ pending: [{ agentId: "agent-2" }, { agentId: "" }, null, 7] })), [{ agentId: "agent-2", createdAtMs: 0, lastSendAtMs: 0, coalescedCount: 1, redriveAttempts: 0 }]);
    // A second write replaces what the first said about the same agent.
    const upserting = new SlateAckObligationStore(root());
    upserting.upsert({ agentId: "agent-3", createdAtMs: 1, lastSendAtMs: 1, coalescedCount: 1, redriveAttempts: 0 });
    upserting.upsert({ agentId: "agent-3", createdAtMs: 2, lastSendAtMs: 2, coalescedCount: 5, redriveAttempts: 1 });
    assert.deepEqual(upserting.list(), [{ agentId: "agent-3", createdAtMs: 2, lastSendAtMs: 2, coalescedCount: 5, redriveAttempts: 1 }]);
  });

  it("keeps an obligation's numbers finite and inside the bounds the platform keeps", () => {
    assert.equal(finiteNumber(Number.NaN, 7), 7);
    assert.equal(finiteNumber("3", 7), 7);
    assert.equal(finiteNumber(3, 7), 3);
    assert.equal(coerceObligation(null), null);
    assert.equal(coerceObligation("agent-1"), null);
    assert.equal(coerceObligation({ agentId: "" }), null);
    assert.deepEqual(coerceObligation({ agentId: "agent-4", coalescedCount: 0, redriveAttempts: -3, lastSendAtMs: "x", lastInterruptAtMs: Number.NaN }), { agentId: "agent-4", createdAtMs: 0, lastSendAtMs: 0, coalescedCount: 1, redriveAttempts: 0 });
  });
});

describe("sharing a room with another user's computer", () => {
  interface Harness {
    service: SlateXuserSharingService;
    clock: Clock & { advance(ms: number): Promise<void> };
    calls: Array<{ path: string; body: unknown }>;
    managerCalls: Array<[string, unknown]>;
    emits: unknown[];
    approvals: unknown[];
    warns: string[];
    restore: () => void;
    fetchImpl: typeof fetch;
  }

  const room = { roomId: "room-1", name: "Room", hostAuthId: "self-1", members: [{ kind: "agent", authId: "self-1", agentId: "agent-1" }, { kind: "human", authId: "user-2", displayName: "Bob" }] };
  const joinable = { roomId: "room-1", name: "Room", hostAuthId: "host-other", hostName: "Bob's computer", members: [{ kind: "human", authId: "self-1", displayName: "Me" }, { kind: "agent", authId: "self-1", agentId: "agent-1" }] };

  function harness(options: { enabled?: boolean; rooms?: unknown[]; joinRequests?: unknown[]; selfAuthId?: string | null; rejectIdentity?: boolean; avatarRefused?: boolean; profileMissing?: boolean } = {}): Harness {
    const clock = testClock();
    const calls: Array<{ path: string; body: unknown }> = [];
    const managerCalls: Array<[string, unknown]> = [];
    const emits: unknown[] = [];
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.join(" ")); };
    const manager = new Proxy({}, { get: (_target, name) => async (...args: unknown[]) => {
      managerCalls.push([String(name), args[0]]);
      if (name === "getAgentDisplayProfile") return options.profileMissing === true ? null : { name: "Agent One", description: "" };
      if (name === "getAgentAvatar") { if (options.avatarRefused === true) throw new Error("no avatar"); return { dataUrl: "data:image/png;base64,AAAA" }; }
      if (name === "runRemoteRequestedMemberTurn") return ["one", "two", "three"];
      if (name === "ensureHostedSharedRoom") return "local-agent-7";
      return null;
    } }) as unknown as SharingManager;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = new URL(url).pathname;
      calls.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      if (path === "/slate/share-state") return new Response(JSON.stringify({ pendingJoinRequests: options.joinRequests ?? [], rooms: options.rooms ?? [room] }), { status: 200 });
      if (path === "/slate/share-rooms/from-agent") return new Response(JSON.stringify({ shareUrl: "https://example.invalid/s/1", expiresAtMs: 42, room: { roomId: "room-9" } }), { status: 200 });
      if (path === "/slate/share-rooms/invite-links") return new Response(JSON.stringify({ shareUrl: "https://example.invalid/invite/7", expiresAtMs: 99, room: { roomId: "room-1" } }), { status: 200 });
      if (path === "/slate/share-rooms") return new Response(JSON.stringify({ status: "created", room: { roomId: "room-7", name: "Group", hostAuthId: "self-1", members: [{ kind: "agent", authId: "self-1", agentId: "agent-1" }] } }), { status: 200 });
      if (path === "/slate/share-rooms/join/respond") return new Response(JSON.stringify({ status: "approved", room }), { status: 200 });
      if (path === "/slate/share-rooms/join") return new Response(JSON.stringify({ status: "already-member", room: { roomId: "room-3", name: "Their room" } }), { status: 200 });
      if (path === "/slate/xuser/send") return new Response(JSON.stringify({ timestampMs: 77 }), { status: 200 });
      if (path === "/slate/xuser/poll") return new Response(JSON.stringify({ events: [] }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    };
    const getSelfAuthId = options.rejectIdentity === true
      ? async () => { throw new Error("no token"); }
      : async () => (options.selfAuthId === undefined ? "self-1" : options.selfAuthId);
    const deps: SharingDependencies = {
      getAccessToken: async () => "token",
      getBackendUrl: () => "https://backend.invalid",
      getSelfAuthId,
      isEnabled: () => options.enabled ?? true,
      manager,
      emitSharing: (state) => { emits.push(state); },
      resolveAttachment: async () => null,
      timing: {
        clock,
        relayPoll: createPollingPolicy(clock, { name: "relay", intervalMs: 4_000 }),
        reconcilePoll: createPollingPolicy(clock, { name: "reconcile", intervalMs: STATE_RECONCILE_INTERVAL_MS }),
        selfIdentityRetry: createPollingPolicy(clock, { name: "identity", intervalMs: SELF_IDENTITY_RETRY_MS }),
        remoteTurnDeadline: createDeadlinePolicy(clock, { name: "remote-turn", timeoutMs: 60_000 }),
        typingExpiry: (delayMs) => createExpiryPolicy(clock, { name: "typing", ttlMs: delayMs }),
      },
      fetchImpl,
    };
    const service = new SlateXuserSharingService(deps);
    return { service, clock, calls, managerCalls, emits, approvals: [], warns, restore: () => { console.warn = originalWarn; }, fetchImpl };
  }

  it("stays off, and says so, when sharing is off", async () => {
    const { service, calls, emits, emits: _unused, ...rest } = harness({ enabled: false });
    assert.equal(service.getState(), EMPTY_SLATE_SHARING_STATE);
    await service.start();
    assert.equal(emits.length, 1);
    assert.equal(emits[0], EMPTY_SLATE_SHARING_STATE);
    assert.equal(calls.length, 0);
    assert.deepEqual(await service.createRoomFromAgent("agent-1"), { status: "error", message: "Sharing isn't enabled." });
    assert.deepEqual(await service.createRoomInvite("room-1"), { status: "error", message: "Sharing isn't enabled." });
    assert.deepEqual(await service.createSharedRoom({ agents: [] }), { status: "error", message: "Sharing isn't enabled." });
    assert.equal(await service.handleEvent({ kind: "room-post", roomId: "room-1" }), true);
    await service.setRoomTyping("room-1", true);
    assert.equal(calls.length, 0);
    rest.restore();
  });

  it("reads the account in, takes the rooms from the relay, and starts polling", async () => {
    const { service, calls, emits, restore } = harness();
    assert.equal(STATE_RECONCILE_INTERVAL_MS, 5 * 60_000);
    assert.equal(SELF_IDENTITY_RETRY_MS, 1_000);
    await service.start();
    const state = service.getState();
    assert.equal(state.isEnabled, true);
    assert.equal(state.selfAuthId, "self-1");
    assert.deepEqual(state.rooms.map((item) => item.roomId), ["room-1"]);
    assert.equal(emits.length > 0, true);
    assert.deepEqual(calls.map((call) => call.path).filter((path) => path !== "/slate/xuser/poll"), ["/slate/share-state", "/slate/share-rooms/agents/add"]);
    // The host's own agent is republished with the name the platform knows it by.
    assert.deepEqual(calls.find((call) => call.path === "/slate/share-rooms/agents/add")?.body, { roomId: "room-1", agentId: "agent-1", agentName: "Agent One", avatarDataUrl: "data:image/png;base64,AAAA" });
    assert.equal(calls.some((call) => call.path === "/slate/xuser/poll"), true);
    assert.equal(service.findAgentShareRoomId("agent-1"), "room-1");
    assert.equal(service.findAgentShareRoomId("agent-2"), null);
    service.stop();
    restore();
  });

  it("takes a join request once, with the guest's name clamped", async () => {
    const { service, emits, restore } = harness();
    await service.start();
    const before = emits.length;
    assert.equal(await service.handleEvent({ kind: "room-join-request", request: { requestId: "ask-1", roomId: "room-1", requesterAuthId: "user-2", requesterName: "  Bob  ", createdAtMs: 5 } }), true);
    assert.deepEqual(service.getState().pendingJoinRequests, [{ requestId: "ask-1", roomId: "room-1", roomName: "Shared room", requesterAuthId: "user-2", requesterName: "Bob", createdAtMs: 5 }]);
    assert.equal(emits.length, before + 1);
    // The same request is not queued twice, and one without an id is not queued at all.
    await service.handleEvent({ kind: "room-join-request", request: { requestId: "ask-1", requesterName: "Someone else" } });
    await service.handleEvent({ kind: "room-join-request", request: { requesterName: "Nobody" } });
    assert.equal(service.getState().pendingJoinRequests.length, 1);
    restore();
  });

  it("follows typing from a member of the room, for as long as they say, and drops it after", async () => {
    const { service, clock, restore } = harness();
    await service.start();
    assert.equal(await service.handleEvent({ kind: "room-typing", isTyping: true, user: { roomId: "room-1", authId: "user-2", name: "  Bob  ", expiresAtMs: clock.now() + 5_000 } }), true);
    assert.deepEqual(service.getState().typingUsers, [{ roomId: "room-1", authId: "user-2", name: "Bob", expiresAtMs: clock.now() + 5_000 }]);
    assert.equal(service.typingExpiryHandles.size, 1);
    await clock.advance(6_000);
    assert.deepEqual(service.getState().typingUsers, []);
    assert.equal(service.typingExpiryHandles.size, 0);
    await service.handleEvent({ kind: "room-typing", isTyping: true, user: { roomId: "room-1", authId: "user-2", name: "Bob", expiresAtMs: clock.now() + 5_000 } });
    await service.handleEvent({ kind: "room-typing", isTyping: false, user: { roomId: "room-1", authId: "user-2", name: "Bob", expiresAtMs: clock.now() + 5_000 } });
    assert.deepEqual(service.getState().typingUsers, []);
    restore();
  });

  it("ignores typing that names somebody who is not in the room, or a room of their own", async () => {
    const { service, clock, restore } = harness();
    await service.start();
    await service.handleEvent({ kind: "room-typing", isTyping: true, user: { roomId: "room-1", authId: "user-9", name: "Stranger", expiresAtMs: clock.now() + 5_000 } });
    await service.handleEvent({ kind: "room-typing", isTyping: true, user: { roomId: "room-unknown", authId: "user-2", name: "Bob", expiresAtMs: clock.now() + 5_000 } });
    assert.deepEqual(service.getState().typingUsers, []);
    assert.equal(service.typingUsers.size, 0);

    const own = harness({ rooms: [joinable] });
    await own.service.start();
    await own.service.handleEvent({ kind: "room-typing", isTyping: true, user: { roomId: "room-1", authId: "self-1", name: "Me", expiresAtMs: own.clock.now() + 9_000 } });
    // The user's own typing is remembered so their other windows agree, but never shown back to them.
    assert.equal(own.service.typingUsers.size, 1);
    assert.deepEqual(own.service.getState().typingUsers, []);
    restore();
    own.restore();
  });

  it("carries a guest's post into the room, and neither a post nor an entry into a room it left", async () => {
    const { service, managerCalls, restore } = harness();
    await service.start();
    await service.handleEvent({ kind: "room-post", roomId: "room-1", authorAuthId: "user-2", authorName: "  Bob  ", text: "hello", images: [{ base64: "AAAA", mediaType: "image/jpeg" }, { mediaType: "image/png" }], timestampMs: 30 });
    assert.deepEqual(managerCalls.find(([name]) => name === "postSharedRoomGuestMessage")?.[1], { roomId: "room-1", authorAuthId: "user-2", authorName: "Bob", text: "hello", images: [{ base64: "AAAA", mediaType: "image/jpeg" }], timestampMs: 30 });
    const entry = await service.handleEvent({ kind: "room-entry", roomId: "room-1", entry: { entryId: "entry-1", kind: "human-message", authorAuthId: "user-2", text: "hi", timestampMs: 5 } });
    assert.equal(entry, null);
    assert.deepEqual(managerCalls.find(([name]) => name === "appendMirrorRoomEntry")?.[1], { roomId: "room-1", entry: { kind: "human-message", entryId: "entry-1", authorAuthId: "user-2", authorName: "Someone", text: "hi", images: [], timestampMs: 5 }, selfAuthId: "self-1" });
    // A room the host walked away from stops carrying anything into it.
    await service.leaveSharedRoom("room-1");
    assert.equal(service.isRoomAbandoned("room-1"), true);
    const writes = managerCalls.length;
    await service.handleEvent({ kind: "room-post", roomId: "room-1", authorAuthId: "user-2", text: "still there?" });
    await service.handleEvent({ kind: "room-entry", roomId: "room-1", entry: { entryId: "entry-2", kind: "human-message", authorAuthId: "user-2", text: "hi", timestampMs: 6 } });
    assert.equal(managerCalls.length, writes);
    assert.deepEqual(service.getState().rooms, []);
    restore();
  });

  it("mirrors an entry only once it knows whose it is", async () => {
    const signedOut = harness({ selfAuthId: null, rooms: [joinable] });
    await signedOut.service.start();
    assert.equal(signedOut.service.getState().selfAuthId, null);
    assert.equal(await signedOut.service.handleEvent({ kind: "room-entry", roomId: "room-1", entry: { entryId: "entry-1", kind: "human-message", authorAuthId: "user-2", text: "hi", timestampMs: 5 } }), false);
    assert.equal(signedOut.managerCalls.some(([name]) => name === "appendMirrorRoomEntry"), false);
    assert.equal(signedOut.service.findAgentShareRoomId("agent-1"), null);
    signedOut.restore();
  });

  it("runs the turn another host asked for and answers with what the agent said", async () => {
    const { service, calls, managerCalls, restore } = harness({ rooms: [joinable] });
    await service.start();
    await service.handleEvent({ kind: "turn-request", roomId: "room-1", turnNonce: "nonce-1", agentId: "agent-1", hostAuthId: "host-other", groupName: "Group", peers: [{ name: "Bob", description: "a person" }], newMessages: [{ speakerKind: "human", speakerName: "Bob", text: "hi" }] });
    await settle();
    assert.deepEqual(managerCalls.find(([name]) => name === "appendSharedRoomActivityNotice")?.[1], { roomId: "room-1", text: "Agent One is responding in Room at the request of Bob's computer." });
    const turn = managerCalls.find(([name]) => name === "runRemoteRequestedMemberTurn")?.[1] as { agentId: string; systemPrompt: string; prompt: string };
    assert.equal(turn.agentId, "agent-1");
    assert.equal(turn.systemPrompt.includes("Agent One"), true);
    assert.equal(turn.prompt.includes("hi"), true);
    // Only the first two lines the agent produced go back to the room.
    assert.deepEqual(calls.filter((call) => call.path === "/slate/xuser/send").map((call) => call.body), [{ kind: "turn-result", roomId: "room-1", turnNonce: "nonce-1", agentId: "agent-1", messages: ["one", "two"] }]);
    // The same request arriving twice is answered once.
    await service.handleEvent({ kind: "turn-request", roomId: "room-1", turnNonce: "nonce-1", agentId: "agent-1", hostAuthId: "host-other" });
    await settle();
    assert.equal(calls.filter((call) => call.path === "/slate/xuser/send").length, 1);
    restore();
  });

  it("mints a room for an agent once, hands the invite over when one already exists, and reports one that does not", async () => {
    const fresh = harness({ rooms: [] });
    await fresh.service.start();
    const [first, second] = await Promise.all([fresh.service.createRoomFromAgent("agent-1"), fresh.service.createRoomFromAgent("agent-1")]);
    assert.deepEqual(first, { status: "ok", shareUrl: "https://example.invalid/s/1", expiresAtMs: 42, roomId: "room-9" });
    assert.equal(second, first);
    assert.equal(fresh.calls.filter((call) => call.path === "/slate/share-rooms/from-agent").length, 1);
    fresh.restore();

    const existing = harness();
    await existing.service.start();
    assert.deepEqual(await existing.service.createRoomFromAgent("agent-1"), { status: "ok", shareUrl: "https://example.invalid/invite/7", expiresAtMs: 99, roomId: "room-1" });
    assert.equal(existing.calls.filter((call) => call.path === "/slate/share-rooms/invite-links").length, 1);
    assert.equal(existing.calls.some((call) => call.path === "/slate/share-rooms/from-agent"), false);
    existing.restore();

    const gone = harness({ rooms: [], profileMissing: true });
    await gone.service.start();
    // The agent the profile cannot be read for is reported as gone rather than minted for.
    assert.deepEqual(await gone.service.createRoomFromAgent("agent-1"), { status: "error", message: "That agent no longer exists." });
    gone.restore();
  });

  it("creates a shared room, answers a join request, joins one, and leaves one", async () => {
    const { service, calls, managerCalls, restore } = harness({ rooms: [] });
    await service.start();
    const created = await service.createSharedRoom({ agents: [{ agentId: "agent-1" }], name: "Group" });
    assert.deepEqual(created, { status: "ok", roomId: "room-7", localRoomAgentId: "local-agent-7" });
    // The room is materialized as an existing one first, and then given the agent it was created for.
    const hosted = [...managerCalls].reverse().find(([name]) => name === "ensureHostedSharedRoom")?.[1];
    assert.deepEqual(hosted, { roomId: "room-7", name: "Group", localMemberIds: ["agent-1"], remoteMembers: [], isCreationAllowed: true });
    assert.deepEqual(await service.joinRoom("https://example.invalid/s/1"), { status: "already-member", roomName: "Their room", roomId: "room-3" });

    const withRequest = harness({ joinRequests: [{ requestId: "ask-1", roomName: "Room" }] });
    await withRequest.service.start();
    assert.equal(withRequest.service.getState().pendingJoinRequests.length, 1);
    const state = await withRequest.service.respondToJoinRequest({ requestId: "ask-1", isApproved: true }) as { pendingJoinRequests: unknown[]; rooms: unknown[] };
    assert.equal(state.pendingJoinRequests.length, 0);
    assert.equal(state.rooms.length, 1);
    assert.deepEqual(withRequest.calls.find((call) => call.path === "/slate/share-rooms/join/respond")?.body, { requestId: "ask-1", isApproved: true });
    await withRequest.service.setRoomTyping("room-1", true);
    assert.deepEqual(withRequest.calls.find((call) => call.path === "/slate/xuser/send")?.body, { kind: "room-typing", roomId: "room-1", isTyping: true });

    const leaving = harness();
    await leaving.service.start();
    await leaving.service.leaveSharedRoom("room-1");
    assert.deepEqual(leaving.calls.find((call) => call.path === "/slate/share-rooms/leave")?.body, { roomId: "room-1" });
    assert.equal(leaving.managerCalls.some(([name, args]) => name === "markMirrorRoomRevoked" && args === "room-1"), true);
    // Leaving on somebody else's behalf is not the host's own departure: the mirror room stays.
    const other = harness();
    await other.service.start();
    await other.service.leaveSharedRoom("room-1", "user-2");
    assert.deepEqual(other.calls.find((call) => call.path === "/slate/share-rooms/leave")?.body, { roomId: "room-1", targetAuthId: "user-2" });
    assert.equal(other.service.isRoomAbandoned("room-1"), false);
    assert.equal(other.managerCalls.some(([name]) => name === "markMirrorRoomRevoked"), false);
    restore();
  });

  it("reports a self-identity read that failed, and keeps going without one", async () => {
    const { service, warns, clock, restore } = harness({ rejectIdentity: true });
    await service.start();
    assert.equal(service.getState().selfAuthId, null);
    assert.deepEqual(warns, ["[slate:sharing] self-identity read failed (start)", "[slate:sharing] self-identity read failed (share-state reconcile)"]);
    // It asks again while there is no account, and takes the answer when it comes.
    assert.equal(await service.readSelfAuthId("manual"), null);
    assert.equal(warns.at(-1), "[slate:sharing] self-identity read failed (manual)");
    await clock.advance(SELF_IDENTITY_RETRY_MS);
    assert.equal(warns.length > 3, true);
    restore();
  });

  it("reports the avatar of an agent only when it may be published, and stands in for the manager", async () => {
    const { service, restore } = harness();
    await service.start();
    assert.equal(await service.agentAvatarPayload("agent-1"), "data:image/png;base64,AAAA");
    const delegate = service.buildManagerDelegate();
    assert.equal(delegate.isEnabled(), true);
    assert.equal(typeof delegate.publishRoomEntry, "function");
    restore();

    const refused = harness({ avatarRefused: true });
    await refused.service.start();
    assert.equal(await refused.service.agentAvatarPayload("agent-1"), undefined);
    refused.restore();

    const off = harness({ enabled: false });
    assert.equal(off.service.buildManagerDelegate().isEnabled(), false);
    off.restore();
  });

  it("starts once, and stop clears transient typing timers before a later start", async () => {
    const { service, calls, clock, emits, restore } = harness();
    await service.start();
    await service.start();
    assert.equal(calls.filter((call) => call.path === "/slate/share-state").length, 1);

    await service.handleEvent({
      kind: "room-typing",
      isTyping: true,
      user: { roomId: "room-1", authId: "user-2", name: "Bob", expiresAtMs: clock.now() + 5_000 },
    });
    assert.equal(service.typingExpiryHandles.size, 1);
    const emissionCount = emits.length;
    service.stop();
    assert.equal(service.typingExpiryHandles.size, 0);
    assert.equal(service.getState().typingUsers.length, 0);
    await clock.advance(6_000);
    assert.equal(emits.length, emissionCount, "the disposed timer cannot publish a second expiry");

    await service.start();
    assert.equal(calls.filter((call) => call.path === "/slate/share-state").length, 2);
    service.stop();
    restore();
  });

  it("installs approved room events and abandons a room after a member leaves", async () => {
    const { service, managerCalls, restore } = harness({ rooms: [] });
    await service.start();
    const announced = { ...room, roomId: "announced-room" };
    await service.handleEvent({ kind: "room-upsert", room: announced });
    assert.equal(managerCalls.some(([name, args]) => name === "ensureHostedSharedRoom" && (args as { roomId?: string })?.roomId === "announced-room"), true);

    const approved = { ...room, roomId: "approved-room" };
    await service.handleEvent({ kind: "room-join-decision", isApproved: true, room: approved });
    assert.equal(service.isRoomAbandoned("approved-room"), false);
    await service.handleEvent({ kind: "member-left", roomId: "approved-room" });
    assert.equal(service.isRoomAbandoned("approved-room"), true);
    assert.equal(managerCalls.some(([name, args]) => name === "markMirrorRoomRevoked" && args === "approved-room"), true);
    restore();
  });

  it("treats unknown event kinds as handled without calling inherited object properties", async () => {
    const { service, managerCalls, restore } = harness();
    await service.start();
    const callsBefore = managerCalls.length;
    assert.equal(await service.handleEvent({ kind: "toString" }), true);
    assert.equal(await service.handleEvent({ kind: "unknown-room-event" }), true);
    assert.equal(managerCalls.length, callsBefore);
    restore();
  });
});
