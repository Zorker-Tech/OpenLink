import { test } from "node:test"
import assert from "node:assert/strict"

import { createCallMcpTool, createMcpTool } from "../../source/packages/agent/tools/mcp/mcp.ts"
import { indexInteropMcpDescriptors } from "../../source/adapters/interop/agent/mcp-descriptor-index-adapter.ts"
import { McpToolResult } from "../../source/adapters/interop/proto/generated/agent/v1/mcp_tool_pb.ts"
import { McpResult, McpSuccess } from "../../source/adapters/interop/proto/generated/agent/v1/mcp_exec_pb.ts"
import { McpDescriptor, McpMetaToolOptions, McpToolDescriptor } from "../../source/adapters/interop/proto/generated/agent/v1/mcp_pb.ts"
import { Value } from "@bufbuild/protobuf"
import { CustomToolCallError, ToolCallRejectedError, ToolErrorClassification } from "../../source/packages/agent/tools/tool-errors.ts"
import { McpPermissionDeniedError } from "../../source/packages/agent/tools/mcp/mcp-result-boundary.ts"

import { createContext } from "../../source/packages/context/context.ts"
import { conversationIdKey } from "../../source/packages/agent/utils/request-scope.ts"
import { smartModeClassifierExecutorResource } from "../../source/packages/agent-exec/smart-mode-classifier-operation.ts"
import { smartModeMcpApprovalStoreResource } from "../../source/packages/agent/tools/mcp/smart-mode-approval-store.ts"
import { SmartModeClassifierDecision, SmartModeClassifierResult } from "../../source/adapters/interop/proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts"
import { AgentType } from "../../source/packages/agent/utils/agent-config.ts"

// ---------------------------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------------------------

const toolDescriptor = (toolName: string, definitionPath?: string) =>
  new McpToolDescriptor({
    toolName,
    description: `${toolName} does something`,
    inputSchema: Value.fromJson({ type: "object", properties: { query: { type: "string" } } }),
    ...(definitionPath === undefined ? {} : { definitionPath }),
  })

const descriptor = (serverIdentifier: string, tools: McpToolDescriptor[]) =>
  new McpDescriptor({ serverIdentifier, serverName: serverIdentifier, tools })

/** An executor that answers with whatever the test says and records what it was asked. */
const execSuccess = () => new McpResult({ result: { case: "success", value: new McpSuccess({}) } })

function executor(behaviour: { result?: McpResult; error?: Error } = {}) {
  const calls: unknown[] = []
  return {
    calls,
    executor: {
      async execute(_ctx: unknown, args: unknown, options: unknown) {
        calls.push({ args, options })
        if (behaviour.error !== undefined) throw behaviour.error
        return behaviour.result ?? execSuccess()
      },
    },
  }
}

const accessor = (implementation: unknown) => ({
  get: () => implementation,
})

const toolMap = (...tools: Array<Record<string, unknown>>) => ({
  modelVisibleTools: tools,
  additionalExecutableTools: [],
}) as never

const interactionHandler = (options: { result?: unknown } = {}) => ({
  invocationId: "invocation-1",
  async executeToolCall(_ctx: unknown, _toolCall: unknown, _callId: string, run: (ctx: unknown) => Promise<unknown>) {
    return await run(_ctx)
  },
  ...options,
})

const stream = (value: unknown) => (async function* () { yield JSON.stringify(value) })()
const failureOf = async (promise: Promise<unknown>): Promise<Error> => { try { await promise } catch (error) { return error as Error } throw new Error("expected the call to fail") }

// ---------------------------------------------------------------------------------------------
// a tool from a server
// ---------------------------------------------------------------------------------------------

test("a server's tool is offered under its own normalized name", () => {
  const tool = createMcpTool(accessor(executor().executor) as never, {
    name: "github.create.issue",
    providerIdentifier: "github",
    toolName: "create_issue",
    description: "Creates an issue",
    inputSchema: Value.fromJson({ type: "object", properties: { title: { type: "string" } } }),
  } as never)
  assert.equal(tool.toolIdentifier, "MCP")
  assert.equal(tool.name, "github_create_issue")
  assert.equal((tool.descriptionGenerator as () => string)(), "Creates an issue")
})

test("a tool name that is too long for a provider is shortened with a stable suffix", () => {
  const long = "a".repeat(80)
  const tool = createMcpTool(accessor(executor().executor) as never, {
    name: long,
    providerIdentifier: "github",
    toolName: "create_issue",
  } as never)
  const name = tool.name as string
  assert.equal(name.length, 64)
  assert.equal(name.startsWith("a".repeat(57)), true)
  // The suffix is derived from the name, so the same tool keeps the same name.
  const again = createMcpTool(accessor(executor().executor) as never, {
    name: long,
    providerIdentifier: "github",
    toolName: "create_issue",
  } as never)
  assert.equal(again.name, name)
})

test("a schema that is missing or empty is still a schema", () => {
  const withoutSchema = createMcpTool(accessor(executor().executor) as never, {
    name: "tool",
    providerIdentifier: "server",
    toolName: "tool",
  } as never)
  const parameters = withoutSchema.parameters as { jsonSchema: Record<string, unknown> }
  assert.deepEqual(parameters.jsonSchema, { type: "object", properties: {} })
  const emptySchema = createMcpTool(accessor(executor().executor) as never, {
    name: "tool",
    providerIdentifier: "server",
    toolName: "tool",
    inputSchema: Value.fromJson({ type: "object", properties: {} }),
  } as never)
  const emptyParameters = emptySchema.parameters as { jsonSchema: Record<string, unknown> }
  assert.deepEqual(emptyParameters.jsonSchema, { type: "object", properties: {} })
})

test("a schema whose properties are not an object is passed through as it is", () => {
  // The schema is the server's, so a shape this code does not recognize is not rewritten.
  const malformed = createMcpTool(accessor(executor().executor) as never, {
    name: "tool",
    providerIdentifier: "server",
    toolName: "tool",
    inputSchema: Value.fromJson({ type: "object", properties: "a string" } as never),
  } as never)
  const parameters = malformed.parameters as { jsonSchema: Record<string, unknown> }
  assert.deepEqual(parameters.jsonSchema, { type: "object", properties: "a string" })
})

test("a call to a server's tool reaches the executor with the arguments it was given", async () => {
  const recorded = executor()
  const tool = createMcpTool(accessor(recorded.executor) as never, {
    name: "github_create_issue",
    providerIdentifier: "github",
    toolName: "create_issue",
  } as never)
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await execute(createContext(), interactionHandler(), stream({ title: "a bug" }), { toolCallId: "call-1" })
  assert.equal(recorded.calls.length, 1)
  const args = (recorded.calls[0] as { args: { toolName: string; providerIdentifier: string; args: Record<string, unknown> } }).args
  assert.equal(args.toolName, "create_issue")
  assert.equal(args.providerIdentifier, "github")
  assert.deepEqual(Object.keys(args.args), ["title"])
})

test("arguments that are not JSON are refused before anything is asked of the server", async () => {
  const recorded = executor()
  const tool = createMcpTool(accessor(recorded.executor) as never, {
    name: "github_create_issue",
    providerIdentifier: "github",
    toolName: "create_issue",
  } as never)
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await assert.rejects(
    () => execute(createContext(), interactionHandler(), (async function* () { yield "{not json" })(), { toolCallId: "call-1" }),
    /not valid JSON/,
  )
  await assert.rejects(
    () => execute(createContext(), interactionHandler(), (async function* () { yield '"a string"' })(), { toolCallId: "call-1" }),
    /must be a JSON object/,
  )
  assert.deepEqual(recorded.calls, [])
})

test("a tool that fails records the failure and raises it", async () => {
  const recorded = executor({ error: new Error("the server refused") })
  const tool = createMcpTool(accessor(recorded.executor) as never, {
    name: "github_create_issue",
    providerIdentifier: "github",
    toolName: "create_issue",
  } as never)
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await assert.rejects(() => execute(createContext(), interactionHandler(), stream({}), { toolCallId: "call-1" }), /the server refused/)
})

test("a failure is serialized into the shape a call reports", () => {
  const tool = createMcpTool(accessor(executor().executor) as never, {
    name: "github_create_issue",
    providerIdentifier: "github",
    toolName: "create_issue",
  } as never)
  const call = (tool.serializeError as (error: unknown) => { tool: { case: string; value: { result?: { result?: { case?: string; value?: { error?: string } } } } } })(new Error("the server refused"))
  assert.equal(call.tool.case, "mcpToolCall")
  assert.equal(call.tool.value.result?.result?.case, "error")
  assert.equal(call.tool.value.result?.result?.value?.error, "Tool execution error")
})

// ---------------------------------------------------------------------------------------------
// the tool that calls any tool
// ---------------------------------------------------------------------------------------------

const callOptions = (overrides: Record<string, unknown> = {}) => ({
  resourceAccessor: accessor(executor().executor),
  // Without a state handler the session tracks nothing it has read, so the descriptors are checked.
  validateMcpToolDescriptors: true,
  mcpFileSystemOptions: { mcpDescriptors: [descriptor("github", [toolDescriptor("create_issue", "/defs/github.json")])] } as never,
  ...overrides,
}) as never

test("the meta tool is named for what the model calls", () => {
  const tool = createCallMcpTool(callOptions())
  assert.equal(tool.toolIdentifier, "MCP")
  assert.equal(tool.name, "CallMcpTool")
})

test("a call to a server the session does not have is refused", async () => {
  const tool = createCallMcpTool(callOptions())
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await assert.rejects(
    () => execute(createContext(), interactionHandler(), stream({ server: "gitlab", toolName: "create_issue", arguments: {} }), { toolCallId: "call-1" }),
    /gitlab/,
  )
})

test("a server the session does not have is refused when the session tracks its reads", async () => {
  // With a session that tracks what it has read, a server it does not have is refused here rather than
  // discovered by the executor.
  const tool = createCallMcpTool(callOptions({ validateMcpToolDescriptors: false }))
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await assert.rejects(
    () => execute(createContext(), interactionHandler(), stream({ server: "gitlab", toolName: "create_issue", arguments: {} }), {
      toolCallId: "call-1",
      stateHandler: { hasReadPath: () => false },
    }),
    /gitlab/,
  )
})

test("a definition the session has not read does not stop the call here", async () => {
  // The read check is one of several: what this call does about an unread definition is proceed, and the
  // platform's own guards decide the rest.
  const recorded = executor()
  const tool = createCallMcpTool(callOptions({ resourceAccessor: accessor(recorded.executor), validateMcpToolDescriptors: false }))
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await execute(createContext(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: {} }), {
    toolCallId: "call-1",
    stateHandler: { hasReadPath: () => false },
  })
  assert.equal(recorded.calls.length, 1)
})

test("a call to a tool the server does not have is refused", async () => {
  const tool = createCallMcpTool(callOptions())
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await assert.rejects(
    () => execute(createContext(), interactionHandler(), stream({ server: "github", toolName: "delete_everything", arguments: {} }), { toolCallId: "call-1" }),
    /delete_everything/,
  )
})

test("a call reaches the executor with the server, the tool and the arguments", async () => {
  const recorded = executor()
  const tool = createCallMcpTool(callOptions({ resourceAccessor: accessor(recorded.executor) }))
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await execute(createContext(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: { title: "a bug" } }), { toolCallId: "call-1" })
  assert.equal(recorded.calls.length, 1)
  const args = (recorded.calls[0] as { args: { serverIdentifier: string; toolName: string; args: Record<string, unknown> } }).args
  assert.equal(args.serverIdentifier, "github")
  assert.equal(args.toolName, "create_issue")
  assert.deepEqual(Object.keys(args.args), ["title"])
})

test("authenticating a server is refused where no user can approve it", async () => {
  // The descriptors are not validated here, which is the case where the auth tool can still be named.
  const tool = createCallMcpTool(callOptions({ validateMcpToolDescriptors: false }))
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await assert.rejects(
    () => execute(createContext(), interactionHandler(), stream({ server: "github", toolName: "mcp_auth", arguments: {} }), { toolCallId: "call-1" }),
    /Slate desktop IDE/,
  )
})

test("a tool the platform reserves for the parent agent is refused", async () => {
  const tool = createCallMcpTool(callOptions({
    isMcpToolBlocked: ({ toolName }: { toolName: string }) => toolName === "create_issue",
  }))
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await assert.rejects(
    () => execute(createContext(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: {} }), { toolCallId: "call-1" }),
    /not available in this agent context/,
  )
})

test("arguments sent as a quoted string are refused with how to fix the call", async () => {
  const recorded = executor()
  const tool = createCallMcpTool(callOptions({ resourceAccessor: accessor(recorded.executor) }))
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await assert.rejects(
    () => execute(createContext(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: "not an object" }), { toolCallId: "call-1" }),
    /as a JSON object literal rather than a quoted string/,
  )
  assert.deepEqual(recorded.calls, [])
})

test("a call with no arguments at all is a call with none", async () => {
  const recorded = executor()
  const tool = createCallMcpTool(callOptions({ resourceAccessor: accessor(recorded.executor) }))
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await execute(createContext(), interactionHandler(), stream({ server: "github", toolName: "create_issue" }), { toolCallId: "call-1" })
  const args = (recorded.calls[0] as { args: { args: Record<string, unknown> } }).args
  assert.deepEqual(args.args, {})
})

test("a call that fails is recorded and raised", async () => {
  const recorded = executor({ error: new Error("the server is down") })
  const tool = createCallMcpTool(callOptions({ resourceAccessor: accessor(recorded.executor) }))
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await assert.rejects(
    () => execute(createContext(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: {} }), { toolCallId: "call-1" }),
    /the server is down/,
  )
})

// ---------------------------------------------------------------------------------------------
// what the session knows about its servers
// ---------------------------------------------------------------------------------------------

test("the descriptors are indexed by the server's own identifier", () => {
  const index = indexInteropMcpDescriptors({
    mcpMetaToolEnabled: false,
    mcpFileSystemOptions: { mcpDescriptors: [descriptor("github", [toolDescriptor("create_issue", "/defs/github.json")])] } as never,
  })
  assert.deepEqual([...index.serverDescriptors.keys()], ["github"])
  assert.equal(index.toolDefinitionPaths.get("github:create_issue"), "/defs/github.json")
})

test("the auth tool is only offered where authentication can happen", () => {
  const descriptors = [descriptor("github", [toolDescriptor("mcp_auth"), toolDescriptor("create_issue")])]
  const without = indexInteropMcpDescriptors({ mcpMetaToolEnabled: false, mcpFileSystemOptions: { mcpDescriptors: descriptors } as never })
  assert.deepEqual(without.serverDescriptors.get("github")?.tools.map(tool => tool.toolName), ["create_issue"])
  const withAuth = indexInteropMcpDescriptors({ mcpMetaToolEnabled: false, mcpFileSystemOptions: { mcpDescriptors: descriptors } as never, allowInteractiveMcpAuth: true })
  assert.deepEqual(withAuth.serverDescriptors.get("github")?.tools.map(tool => tool.toolName), ["mcp_auth", "create_issue"])
})

test("the meta tool's own descriptor list is used when it is enabled", () => {
  const index = indexInteropMcpDescriptors({
    mcpMetaToolEnabled: true,
    mcpMetaToolOptions: { mcpDescriptors: [descriptor("from-meta", [toolDescriptor("a")])] } as never,
    mcpFileSystemOptions: { mcpDescriptors: [descriptor("from-files", [toolDescriptor("b")])] } as never,
  })
  assert.deepEqual([...index.serverDescriptors.keys()], ["from-meta"])
})

// ---------------------------------------------------------------------------------------------
// the review a call may have to pass
// ---------------------------------------------------------------------------------------------

const classifierAnswer = (decision: number, blockReason?: string) => new SmartModeClassifierResult({ result: { case: "success", value: { decision, ...(blockReason === undefined ? {} : { blockReason }) } } });

function reviewedWorld(behaviour: { answer?: () => SmartModeClassifierResult; store?: unknown; tools?: unknown } = {}) {
  const classifierCalls: unknown[] = [];
  const storeCalls: unknown[] = [];
  const executorRecord = executor();
  const accessor = {
    get: (resource: unknown) => {
      if (resource === smartModeClassifierExecutorResource) return { async execute(_ctx: unknown, args: unknown) { classifierCalls.push(args); return behaviour.answer?.() ?? classifierAnswer(SmartModeClassifierDecision.ALLOW); } };
      if (resource === smartModeMcpApprovalStoreResource) return behaviour.store ?? { async createPendingRequest(_ctx: unknown, request: unknown) { storeCalls.push(request); }, async deletePendingRequest() {} };
      return executorRecord.executor;
    },
  };
  const tool = createCallMcpTool(callOptions({ resourceAccessor: accessor, smartModeClassifierMode: true, ...(behaviour.tools as Record<string, unknown> ?? {}) }));
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>;
  const conversation = () => createContext().with(conversationIdKey, "conversation-1");
  return { tool, execute, classifierCalls, storeCalls, recorded: executorRecord.calls, conversation };
}

test("a call the review allows runs without waiting for anyone", async () => {
  const world = reviewedWorld();
  await world.execute(world.conversation(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: {} }), { toolCallId: "call-1" });
  assert.equal(world.classifierCalls.length, 1);
  assert.equal(world.recorded.length, 1);
})

test("a call the review blocks is refused with the two ways forward, and with the dynamic name when namespaces are used", async () => {
  const world = reviewedWorld({ answer: () => classifierAnswer(SmartModeClassifierDecision.BLOCK, "looks risky") });
  const error = await failureOf(world.execute(world.conversation(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: {} }), { toolCallId: "call-1" }));
  assert.match(error.message, /looks risky/);
  assert.match(error.message, /call_mcp_tool/);
  assert.equal(world.recorded.length, 0);
})

test("a blocked call is shown as an approval to the provider, which may approve or deny it", async () => {
  const requests: unknown[] = [];
  const approved = reviewedWorld({
    answer: () => classifierAnswer(SmartModeClassifierDecision.BLOCK, "looks risky"),
    tools: { smartModeApprovalProvider: { async requestApproval(request: unknown) { requests.push(request); return { approved: true }; } } },
  });
  await approved.execute(approved.conversation(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: { a: 1 } }), { toolCallId: "call-1" });
  assert.equal((requests[0] as { target: { toolName: string } }).target.toolName, "create_issue");
  assert.equal(approved.recorded.length, 1);
  const denied = reviewedWorld({
    answer: () => classifierAnswer(SmartModeClassifierDecision.BLOCK, "looks risky"),
    tools: { smartModeApprovalProvider: { async requestApproval() { return { approved: false, reason: "the user said no" }; } } },
  });
  const error = await failureOf(denied.execute(denied.conversation(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: {} }), { toolCallId: "call-1" }));
  assert.match(error.message, /the user said no/);
  assert.equal(denied.recorded.length, 0);
})

test("a call that asked for approval without a provider is stored as a pending request", async () => {
  const world = reviewedWorld({ answer: () => classifierAnswer(SmartModeClassifierDecision.BLOCK, "looks risky") });
  await world.execute(world.conversation(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: {}, requestSmartModeApproval: true, smartModeBlockReason: "parent says no" }), { toolCallId: "call-1" });
  assert.equal(world.storeCalls.length, 1);
  assert.equal((world.storeCalls[0] as { blockReason: string }).blockReason, "parent says no");
  // The call proceeds with the approval attached, which is what lets the platform answer it later.
  assert.equal(world.recorded.length, 1);
})

test("a background agent asking for approval is refused with the parent's reason", async () => {
  const world = reviewedWorld({ answer: () => classifierAnswer(SmartModeClassifierDecision.BLOCK, "looks risky"), tools: { agentType: AgentType.BACKGROUND } });
  const error = await failureOf(world.execute(world.conversation(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: {}, requestSmartModeApproval: true, smartModeBlockReason: "parent says no" }), { toolCallId: "call-1" }));
  assert.match(error.message, /parent says no/);
})

test("a classifier that cannot answer refuses the call as unclassified", async () => {
  const world = reviewedWorld({ answer: () => new SmartModeClassifierResult({ result: { case: "error", value: { error: "the classifier broke" } } }) });
  const error = await failureOf(world.execute(world.conversation(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: {} }), { toolCallId: "call-1" }));
  assert.match(error.message, /classifying|unclassified/);
  assert.equal(world.recorded.length, 0);
})

test("a shadow review asks the classifier and still runs the call", async () => {
  const classifierCalls: unknown[] = [];
  const recorded = executor();
  const accessor = { get: (resource: unknown) => resource === smartModeClassifierExecutorResource ? { async execute(_ctx: unknown, args: unknown) { classifierCalls.push(args); return classifierAnswer(SmartModeClassifierDecision.BLOCK, "risky"); } } : recorded.executor };
  const tool = createCallMcpTool(callOptions({ resourceAccessor: accessor, smartModeClassifierShadowMode: true }));
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>;
  await execute(createContext(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: {} }), { toolCallId: "call-1" });
  // A shadow review without enforcement does not ask the classifier; it only measures when it can act.
  assert.equal(classifierCalls.length, 0);
  assert.equal(recorded.calls.length, 1);
})

test("the review can be forced to block a call in development", async () => {
  const world = reviewedWorld({ tools: { devSmartModeClassifierBlockState: { consume: () => true } } });
  const error = await failureOf(world.execute(world.conversation(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: {} }), { toolCallId: "call-1" }));
  assert.match(error.message, /Auto-review/);
  assert.equal(world.recorded.length, 0);
})

test("both tools can be given a name the provider accepts", () => {
  const perServer = createMcpTool(accessor(executor().executor) as never, { name: "server_tool", providerIdentifier: "server", toolName: "tool" } as never, { name: "renamed_tool" });
  assert.equal(perServer.name, "renamed_tool");
  const meta = createCallMcpTool(callOptions({ name: "CustomCaller" }));
  assert.equal(meta.name, "CustomCaller");
})

test("a session whose descriptors come from the meta tool uses them, and may sign in when it can", async () => {
  const recorded = executor();
  const tool = createCallMcpTool(callOptions({
    resourceAccessor: accessor(recorded.executor),
    mcpMetaToolOptions: new McpMetaToolOptions({ enabled: true, mcpDescriptors: [descriptor("meta", [toolDescriptor("search")])] }),
    mcpFileSystemOptions: undefined,
  }));
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>;
  await execute(createContext(), interactionHandler(), stream({ server: "meta", toolName: "search", arguments: {} }), { toolCallId: "call-1" });
  assert.equal(recorded.calls.length, 1);
  const signedIn = executor();
  const authTool = createCallMcpTool(callOptions({ allowInteractiveMcpAuth: true, validateMcpToolDescriptors: false, resourceAccessor: accessor(signedIn.executor) }));
  const authExecute = authTool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>;
  await authExecute(createContext(), interactionHandler(), stream({ server: "github", toolName: "mcp_auth", arguments: {} }), { toolCallId: "call-1" });
  assert.equal(signedIn.calls.length, 1);
})

test("a dynamic namespace call is read back into a server and tool call", async () => {
  const recorded = executor();
  const tool = createCallMcpTool(callOptions({
    resourceAccessor: accessor(recorded.executor),
    validateMcpToolDescriptors: false,
    dynamicToolRegistry: { find: () => undefined, list: () => [] },
  }));
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>;
  await execute(createContext(), interactionHandler(), stream({ namespace: "github", toolName: "create_issue", mcpDetails: {}, arguments: { title: "x" } }), { toolCallId: "call-1" });
  const args = (recorded.calls[0] as { args: { serverIdentifier: string; args: Record<string, unknown> } }).args;
  assert.equal(args.serverIdentifier, "github");
  assert.deepEqual(Object.keys(args.args), ["title"]);
})

test("a tuple schema is converted to draft 2020-12 only when asked", () => {
  const definition = { name: "tool", providerIdentifier: "server", toolName: "tool", inputSchema: Value.fromJson({ type: "object", properties: { pair: { type: "array", items: [{ type: "string" }, { type: "number" }] } } } as never) };
  const plain = createMcpTool(accessor(executor().executor) as never, definition as never);
  const converted = createMcpTool(accessor(executor().executor) as never, definition as never, { convertTupleSchemaToDraft2020_12: true });
  assert.notDeepEqual((plain.parameters as { jsonSchema: unknown }).jsonSchema, (converted.parameters as { jsonSchema: unknown }).jsonSchema);
})

test("a batch of bad arguments asks the model to read the schema first", async () => {
  const failing = new CustomToolCallError(ToolErrorClassification.INVALID_ARGS, { error: "the arguments did not match", clientVisibleErrorMessage: "bad", modelVisibleErrorMessage: "bad" });
  const tool = createMcpTool(accessor({ async execute() { throw failing; } }) as never, { name: "t", providerIdentifier: "s", toolName: "t" } as never);
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>;
  const error = await failureOf(execute(createContext(), interactionHandler(), stream({}), { toolCallId: "call-1" }));
  assert.match((error as CustomToolCallError).modelVisibleErrorMessage, /schema/);
})

test("a result that is not one renders as an empty result", () => {
  const tool = createMcpTool(accessor(executor().executor) as never, { name: "t", providerIdentifier: "s", toolName: "t" } as never);
  const render = tool.render as (ctx: unknown, output: unknown) => { content?: Array<{ text?: string }> };
  const rendered = (output: unknown) => (render(createContext(), output) as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
  assert.equal(rendered({}), rendered(new McpToolResult()));
})

test("an aborted call never reaches the executor", async () => {
  const recorded = executor();
  const tool = createCallMcpTool(callOptions({ resourceAccessor: accessor(recorded.executor) }));
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>;
  const [cancelled, cancel] = createContext().withCancel();
  cancel();
  await assert.rejects(() => execute(cancelled, interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: {} }), { toolCallId: "call-1" }));
  assert.equal(recorded.calls.length, 0);
})

test("a provider is asked to approve even when the model also asked, and its fingerprint is sent", async () => {
  const requests: Array<{ fingerprint?: string }> = [];
  const world = reviewedWorld({
    answer: () => classifierAnswer(SmartModeClassifierDecision.BLOCK, "looks risky"),
    tools: { smartModeApprovalProvider: { async requestApproval(request: { fingerprint?: string }) { requests.push(request); return { approved: true }; } } },
  });
  await world.execute(world.conversation(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: {}, requestSmartModeApproval: true }), { toolCallId: "call-1" });
  assert.equal(world.storeCalls.length, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.fingerprint?.length, 64);
})

test("an approval request without its own reason carries the fallback reason", async () => {
  const world = reviewedWorld({ answer: () => classifierAnswer(SmartModeClassifierDecision.BLOCK, "looks risky") });
  await world.execute(world.conversation(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: {}, requestSmartModeApproval: true }), { toolCallId: "call-1" });
  assert.match(String((world.storeCalls[0] as { blockReason: string }).blockReason), /classifying/);
})

test("a name at the provider limit is kept whole, and punctuation is sanitized", () => {
  const atLimit = "b".repeat(64);
  const short = createMcpTool(accessor(executor().executor) as never, { name: atLimit, providerIdentifier: "s", toolName: "t" } as never);
  assert.equal(short.name, atLimit);
  const punctuated = createMcpTool(accessor(executor().executor) as never, { name: "github.create-issue", providerIdentifier: "s", toolName: "t" } as never);
  assert.equal(punctuated.name, "github_create-issue");
})

test("the arguments proto names the function, skips null fields and keeps the provider", async () => {
  const recorded = executor();
  const tool = createMcpTool(accessor(recorded.executor) as never, { name: "t", providerIdentifier: "server", toolName: "tool" } as never);
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>;
  await execute(createContext(), interactionHandler(), stream({ a: 1, b: null, c: { d: 2 } }), { toolCallId: "call-1" });
  const args = (recorded.calls[0] as { args: { name: string; providerIdentifier: string; args: Record<string, { toJson?: () => unknown }> } }).args;
  assert.equal(args.name, "server-tool");
  assert.deepEqual(Object.keys(args.args), ["a", "b", "c"]);
})

test("the bad-JSON refusal says what was wrong with the text", async () => {
  const tool = createMcpTool(accessor(executor().executor) as never, { name: "t", providerIdentifier: "s", toolName: "t" } as never);
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>;
  const error = await failureOf(execute(createContext(), interactionHandler(), (async function* () { yield "{not json" })(), { toolCallId: "call-1" }));
  assert.match(error.message, /not valid JSON: /);
})

test("a permission refusal and a rejection are serialized as themselves", () => {
  const tool = createMcpTool(accessor(executor().executor) as never, { name: "t", providerIdentifier: "s", toolName: "t" } as never);
  const serialize = tool.serializeError as (error: unknown) => { tool: { value: { result?: { result?: { case?: string; value?: Record<string, unknown> } } } } };
  const denied = serialize(new McpPermissionDeniedError("readonly", true));
  assert.equal(denied.tool.value.result?.result?.case, "permissionDenied");
  const rejected = serialize(new ToolCallRejectedError("the user said no"));
  assert.equal(rejected.tool.value.result?.result?.case, "rejected");
  assert.equal(rejected.tool.value.result?.result?.value?.reason, "the user said no");
})

test("the classifier is asked about the call as an mcp target in the file-system mode", async () => {
  const world = reviewedWorld();
  await world.execute(world.conversation(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: { a: 1 } }), { toolCallId: "call-1" });
  const target = (world.classifierCalls[0] as { target: { action: string; arguments: { toJson(): Record<string, unknown> } } }).target;
  const fields = target.arguments.toJson() as { mcp_mode?: string; arguments?: unknown; server?: { identifier?: string } };
  assert.equal(target.action, "mcp");
  assert.equal(fields.mcp_mode, "file_system");
  assert.equal(fields.server?.identifier, "github");
  assert.deepEqual(fields.arguments, { a: 1 });
})

test("an approval store that was never configured is raised as it is", async () => {
  const store = { get createPendingRequest() { throw new Error("Auto-review MCP approval store is not configured"); }, async deletePendingRequest() {} };
  const world = reviewedWorld({ answer: () => classifierAnswer(SmartModeClassifierDecision.BLOCK, "risky"), store });
  const error = await failureOf(world.execute(world.conversation(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: {}, requestSmartModeApproval: true }), { toolCallId: "call-1" }));
  assert.match(error.message, /approval store is not configured/);
})

test("a call cancelled while its approval is pending does not run", async () => {
  const [cancelled, cancel] = createContext().withCancel();
  const world = reviewedWorld({
    answer: () => classifierAnswer(SmartModeClassifierDecision.BLOCK, "risky"),
    tools: { smartModeApprovalProvider: { async requestApproval() { cancel(); return { approved: true }; } } },
  });
  await assert.rejects(() => world.execute(cancelled, interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: {} }), { toolCallId: "call-1" }));
  assert.equal(world.recorded.length, 0);
})

test("the pending approval travels with the call to the executor", async () => {
  const world = reviewedWorld({ answer: () => classifierAnswer(SmartModeClassifierDecision.BLOCK, "risky") });
  await world.execute(world.conversation(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: {}, requestSmartModeApproval: true }), { toolCallId: "call-1" });
  const args = (world.recorded[0] as { args: { toJson(): { smartModeApproval?: unknown } } }).args;
  assert.equal((args.toJson().smartModeApproval as { requestId?: string } | undefined)?.requestId !== undefined, true);
})

test("a missing server is refused before the executor is asked", async () => {
  const world = reviewedWorld({ tools: { validateMcpToolDescriptors: false } });
  const error = await failureOf(world.execute(world.conversation(), interactionHandler(), stream({ server: "gitlab", toolName: "create_issue", arguments: {} }), { toolCallId: "call-1", stateHandler: { hasReadPath: () => false } }));
  assert.match(error.message, /gitlab/);
  assert.equal(world.recorded.length, 0);
})

test("the meta tool describes what it does and carries the description to the call", async () => {
  const tool = createCallMcpTool(callOptions());
  assert.match((tool.descriptionGenerator as () => string)(), /Call an MCP tool/);
  const recorded = executor();
  const described = createCallMcpTool(callOptions({ resourceAccessor: accessor(recorded.executor) }));
  const calls: unknown[] = [];
  const handler = { async executeToolCall(_ctx: unknown, call: unknown, _id: string, run: (ctx: unknown) => Promise<unknown>) { calls.push(call); return await run(_ctx); } };
  const execute = described.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>;
  await execute(createContext(), handler, stream({ server: "github", toolName: "create_issue", description: "what it does", arguments: {} }), { toolCallId: "call-1" });
  assert.equal((calls[0] as { tool: { value: { description?: string } } }).tool.value.description, "what it does");
})
