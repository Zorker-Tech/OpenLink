import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createContext } from "../../source/packages/context/context.ts";
import { HOOK_DENIAL_AGENT_NOTE } from "../../source/packages/hooks-exec/hook-errors.ts";
import {
  buildDescriptionGeneratorProps,
  classifyError,
  executeToolResultOrError,
  extractToolMetadataMap,
  getConciseStaticContext,
  getDirectDynamicToolNames,
  getExecutableTools,
  getRequiredToolName,
  isForcedStaticContext,
  isPromptVisibleDescription,
  renderToolResultOrError,
  resolveToolCallIdentity,
  toAgentTools,
  ToolSetHandle,
} from "../../source/packages/agent/tools/tool-execution.ts";
import {
  CustomToolCallError,
  RetryableToolOrchestrationError,
  ToolCallAbortedError,
  ToolCallArgParseError,
  ToolCallRejectedError,
  ToolErrorClassification,
  ToolTimeoutError,
} from "../../source/packages/agent/tools/tool-errors.ts";
import { DeferredInteractionResponseError } from "../../source/packages/agent-core/interaction-queries.ts";
import { RemoteHookBlockedError } from "../../source/packages/agent/tools/remote-hooks.ts";

const tool = (fields: Record<string, unknown>) => ({ toolIdentifier: "T", name: fields.name ?? "tool", parameters: {}, ...fields });

describe("the tool set", () => {
  it("answers the small questions about a tool and its context", () => {
    assert.equal(getRequiredToolName({ t1: { name: "read" } }, "t1"), "read");
    assert.throws(() => getRequiredToolName({}, "missing"), /Required tool missing not found/);
    assert.equal(isPromptVisibleDescription(undefined), true);
    assert.equal(isPromptVisibleDescription({ promptVisible: false }), false);
    assert.equal(isForcedStaticContext({ type: "static" }), true);
    assert.equal(isForcedStaticContext({ type: "dynamic" }), false);
    assert.equal(getConciseStaticContext({ type: "dynamic", conciseStaticContext: "  short  " }), "short");
    assert.equal(getConciseStaticContext({ type: "static", conciseStaticContext: "short" }), undefined);
  });

  it("reads the tool identity a meta tool reports", () => {
    assert.deepEqual(resolveToolCallIdentity({ tool: tool({}), args: {} }), { toolIdentifier: "T", isDynamic: false });
    const meta = tool({ resolveToolCallTelemetry: () => ({ toolIdentifier: "wrapped", extra: 1 }) });
    assert.deepEqual(resolveToolCallIdentity({ tool: meta, args: {}, isDirectDynamicTool: true }), { toolIdentifier: "wrapped", extra: 1, isDynamic: true });
    assert.equal(getExecutableTools({ modelVisibleTools: [tool({})], additionalExecutableTools: [] }).length, 1);
    assert.equal(getExecutableTools({ modelVisibleTools: [tool({})], additionalExecutableTools: [tool({ name: "extra" })] }).length, 2);
    assert.deepEqual([...getDirectDynamicToolNames({ modelVisibleTools: [], additionalExecutableTools: [tool({ name: "a" }), tool({ name: "b" })] })], ["a", "b"]);
  });

  it("builds a handle and answers lookups over it", () => {
    const read = tool({ name: "read", toolIdentifier: "Read", description: "reads" });
    const write = tool({ name: "write", toolIdentifier: "Write", description: "writes" });
    const handle = ToolSetHandle.fromTools([read, write]);
    assert.equal(handle.hasTool("Read"), true);
    assert.equal(handle.getTool("Read"), read);
    assert.deepEqual(handle.getTools("Write"), [write]);
    assert.equal(handle.hasStaticTool("Read"), true);
    assert.equal(handle.getStaticTool("Read"), read);
    assert.deepEqual(handle.getStaticTools(), [read, write]);
    assert.deepEqual(handle.getAllTools(), [read, write]);
    assert.deepEqual(handle.getDynamicTools(), []);
    assert.deepEqual(handle.getToolExecutionSet(), { modelVisibleTools: [read, write], additionalExecutableTools: [] });
  });

  it("keeps dynamic tools hidden until a meta tool can invoke them", () => {
    const staticTool = tool({ name: "static", toolIdentifier: "Static", dynamicToolMetaRole: "discovery" });
    const dynamicTool = tool({ name: "dynamic", toolIdentifier: "Dynamic" });
    const withoutInvoker = ToolSetHandle.fromTools([staticTool, dynamicTool]);
    assert.deepEqual(withoutInvoker.getDynamicTools(), []);
    assert.deepEqual(withoutInvoker.getAllTools().map((value) => value.name), ["static", "dynamic"]);
    const invoker = tool({ name: "invoke", toolIdentifier: "Invoke", dynamicToolMetaRole: "invocation" });
    const replaced: unknown[] = [];
    const registry = { replaceTools: (value: unknown) => replaced.push(value) };
    const withRegistry = ToolSetHandle.fromTools({ staticTools: [staticTool, invoker], dynamicTools: [dynamicTool], dynamicToolRegistry: registry });
    assert.deepEqual(withRegistry.getDynamicTools(), [dynamicTool]);
    assert.equal(withRegistry.getToolExecutionSet([staticTool, invoker]).additionalExecutableTools.length, 1);
    assert.equal(withRegistry.getToolExecutionSet([staticTool]).additionalExecutableTools.length, 0);
    assert.equal(replaced.length, 1);
  });

  it("transforms its tools in place and keeps the dynamic side", () => {
    const staticTool = tool({ name: "static", toolIdentifier: "Static", dynamicToolMetaRole: "discovery" });
    const invoker = tool({ name: "invoke", toolIdentifier: "Invoke", dynamicToolMetaRole: "invocation" });
    const dynamicTool = tool({ name: "dynamic", toolIdentifier: "Dynamic" });
    const registry = { replaceTools: () => {} };
    const handle = ToolSetHandle.fromTools({ staticTools: [staticTool, invoker], dynamicTools: [dynamicTool], dynamicToolRegistry: registry });
    const renamed = tool({ name: "renamed", toolIdentifier: "Static", dynamicToolMetaRole: "discovery" });
    const returned = handle.transformToolsInPlace((values) => values.map((value) => value === staticTool ? renamed : value));
    assert.equal(returned, handle);
    assert.equal(handle.getTool("Static"), renamed);
    assert.deepEqual(handle.getDynamicTools(), [dynamicTool]);
  });

  it("refuses a merge it cannot publish through one registry", () => {
    const registryA = { replaceTools: () => {} };
    const registryB = { replaceTools: () => {} };
    const discovery = tool({ dynamicToolMetaRole: "discovery" });
    const invocation = tool({ dynamicToolMetaRole: "invocation" });
    const a = ToolSetHandle.fromTools({ staticTools: [discovery, invocation], dynamicToolRegistry: registryA });
    const b = ToolSetHandle.fromTools({ staticTools: [discovery, invocation], dynamicToolRegistry: registryB });
    assert.throws(() => a.merge(b), /distinct dynamic registries/);
    const same = ToolSetHandle.fromTools({ staticTools: [discovery, invocation], dynamicToolRegistry: registryA });
    assert.throws(() => a.merge(same), /sharing a dynamic registry/);
    const plainA = ToolSetHandle.fromTools([tool({ name: "a" })]);
    const plainB = ToolSetHandle.fromTools([tool({ name: "b" })]);
    assert.deepEqual(plainA.merge(plainB).getAllTools().map((value) => value.name), ["a", "b"]);
  });
});

describe("classifying a failed tool call", () => {
  it("names the failure the way retry policy expects", () => {
    assert.equal(classifyError(new ToolCallArgParseError("bad args")), ToolErrorClassification.INVALID_ARGS);
    assert.equal(classifyError(new ToolCallAbortedError()), ToolErrorClassification.ABORTED);
    const abort = new Error("stop"); abort.name = "AbortError";
    assert.equal(classifyError(abort), ToolErrorClassification.ABORTED);
    assert.equal(classifyError(new ToolCallRejectedError("user said no")), ToolErrorClassification.USER_REJECTED);
    assert.equal(classifyError(new ToolCallRejectedError("user said no " + HOOK_DENIAL_AGENT_NOTE)), ToolErrorClassification.HOOK_DENIED);
    assert.equal(classifyError(new ToolTimeoutError({ clientVisibleErrorMessage: "timeout", modelVisibleErrorMessage: "timeout", error: "timeout" })), ToolErrorClassification.TIMEOUT);
    const axios = Object.assign(new Error("timeout"), { code: "ECONNABORTED" });
    assert.equal(classifyError(axios), ToolErrorClassification.TIMEOUT);
    const disk = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    assert.equal(classifyError(disk), ToolErrorClassification.BAD_USER_DEVICE_STATE);
    const missing = Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
    assert.equal(classifyError(missing), ToolErrorClassification.UNEXPECTED_ENVIRONMENT);
    assert.equal(classifyError(new RemoteHookBlockedError("blocked", "blocked")), ToolErrorClassification.HOOK_DENIED);
    assert.equal(classifyError(new Error("other")), ToolErrorClassification.OTHER_ERROR);
    const retryable = new RetryableToolOrchestrationError("retry", { classification: ToolErrorClassification.TIMEOUT });
    assert.equal(classifyError(retryable), ToolErrorClassification.TIMEOUT);
  });
});

describe("executing a tool call", () => {
  it("returns a result and renders it", async () => {
    const ctx = createContext();
    const calls: unknown[] = [];
    const handler = {
      markToolCallForArgPreservation: (id: string) => calls.push(["preserve", id]),
      emitToolCallError: async (...args: unknown[]) => calls.push(["emit", ...args]),
      getAbortSignal: () => undefined,
    };
    const executable = tool({
      customToolFormat: {},
      execute: async () => ({ value: 7 }),
      serializeError: () => ({ tool: { value: { result: "serialized" } } }),
    });
    const output = await executeToolResultOrError(executable, ctx, handler as never, (async function* () {})(), { toolCallId: "call-1", enableToolArgPreservation: true });
    assert.deepEqual(output, { result: { value: 7 } });
    assert.deepEqual(calls[0], ["preserve", "call-1"]);
    assert.deepEqual(await renderToolResultOrError(ctx, { render: async () => ({ rendered: true }) } as never, output, {}), { rendered: true });
    assert.deepEqual(await renderToolResultOrError(ctx, { render: async () => ({ rendered: true }) } as never, { ...output, error: new Error("x") }, {}), { rendered: true, isError: true });
  });

  it("passes a deferred interaction through and normalizes another failure", async () => {
    const ctx = createContext();
    const emitted: unknown[] = [];
    const deferred = new DeferredInteractionResponseError({ id: 1, kind: "web-search" });
    const deferredTool = tool({ execute: async () => { throw deferred; }, serializeError: () => ({}) });
    await assert.rejects(() => executeToolResultOrError(deferredTool, ctx, { emitToolCallError: async () => {} } as never, (async function* () {})(), { toolCallId: "c" }), (failure: unknown) => failure === deferred);
    const failure = new ToolCallArgParseError("bad args");
    const failing = tool({
      execute: async () => { throw failure; },
      serializeError: (value: unknown) => ({ tool: { value: { result: String((value as Error).message) } } }),
    });
    const output = await executeToolResultOrError(failing, ctx, { emitToolCallError: async (...args: unknown[]) => emitted.push(args) } as never, (async function* () {})(), { toolCallId: "c2" });
    assert.deepEqual(output.result, "bad args");
    assert.equal(output.error, failure);
    assert.equal(output.errorClassification, ToolErrorClassification.INVALID_ARGS);
    assert.equal(emitted.length, 1);
  });
});

describe("describing tools", () => {
  it("builds the metadata and the agent tools", () => {
    const read = tool({ name: "read", toolIdentifier: "Read", parameters: { type: "object" }, description: "reads" });
    assert.deepEqual(extractToolMetadataMap([read]), { Read: { name: "read", toolIdentifier: "Read", parameters: { type: "object" } } });
    assert.deepEqual(buildDescriptionGeneratorProps([read]), { allTools: { Read: { name: "read", toolIdentifier: "Read", parameters: { type: "object" } } } });
    const generated = tool({ name: "generated", toolIdentifier: "Generated", parameters: {}, descriptionGenerator: (props: unknown) => "generated with " + Object.keys((props as { allTools: object }).allTools).length });
    const agents = toAgentTools([read, generated]);
    assert.deepEqual(agents.map((value) => value.name), ["read", "generated"]);
    assert.equal(agents[1]!.description, "generated with 2");
  });
});
