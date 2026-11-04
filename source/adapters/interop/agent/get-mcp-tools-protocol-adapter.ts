import { Value } from "@bufbuild/protobuf"
import {
  GetMcpToolsAgentResult,
  GetMcpToolsArgs,
  GetMcpToolsError,
  GetMcpToolsSuccess,
  GetMcpToolsToolCall,
} from "../proto/generated/agent/v1/get_mcp_tools_tool_pb.ts"
import { McpStateExecArgs } from "../proto/generated/agent/v1/mcp_exec_pb.ts"
import { ToolCall } from "../proto/generated/agent/v1/agent_pb.ts"
import type { Context } from "../../../packages/context/context.ts"
import type { RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts"
import type { ResourceAccessor } from "../../../packages/agent-exec/resource-provider.ts"
import { mcpInputSchemaToJson, mcpStateExecutorResource } from "../../../packages/agent-exec/mcp-operations.ts"
import type {
  GetMcpToolsRequestView,
  GetMcpToolsResultView,
  McpServerDescriptorView,
  McpToolDescriptorView,
} from "../../../packages/agent/tools/mcp/get-mcp-tools-contracts.ts"

function toolView(value: unknown): McpToolDescriptorView {
  const tool = value as {
    readonly toolName?: unknown
    readonly description?: unknown
    readonly inputSchemaJson?: unknown
    readonly inputSchema?: unknown
  }
  const schemaSource = {
    ...(typeof tool.inputSchemaJson === "string" ? { inputSchemaJson: tool.inputSchemaJson } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema as { toJson(): unknown } } : {}),
  }
  const inputSchema = mcpInputSchemaToJson(schemaSource)
  return {
    toolName: typeof tool.toolName === "string" ? tool.toolName : "",
    ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    ...(inputSchema === undefined ? {} : { inputSchema }),
    ...(tool.inputSchema === undefined && tool.inputSchemaJson === undefined ? {} : { inputSchemaPresent: true }),
  }
}

function serverView(value: unknown): McpServerDescriptorView {
  const server = value as {
    readonly serverIdentifier?: unknown
    readonly serverName?: unknown
    readonly plugin?: unknown
    readonly marketplace?: unknown
    readonly serverUseInstructions?: unknown
    readonly tools?: readonly unknown[]
    readonly status?: unknown
  }
  return {
    serverIdentifier: typeof server.serverIdentifier === "string" ? server.serverIdentifier : "",
    serverName: typeof server.serverName === "string" ? server.serverName : "",
    ...(typeof server.plugin === "string" ? { plugin: server.plugin } : {}),
    ...(typeof server.marketplace === "string" ? { marketplace: server.marketplace } : {}),
    ...(typeof server.serverUseInstructions === "string" ? { serverUseInstructions: server.serverUseInstructions } : {}),
    tools: (server.tools ?? []).map(toolView),
    ...(typeof server.status === "string" ? { status: server.status } : {}),
  }
}

/** Decodes the turn-start server snapshot without exposing the generated descriptor types to tool policy. */
export function projectCapturedMcpServersInterop(value: unknown): McpServerDescriptorView[] {
  const descriptors = (value as { readonly mcpDescriptors?: readonly unknown[] } | undefined)?.mcpDescriptors ?? []
  return descriptors.map(serverView)
}

/** Loads live server state and returns Slate records; absent or failed state keeps the caller's captured snapshot. */
export async function loadMcpServerSnapshotsInterop(
  ctx: Context,
  accessor: ResourceAccessor<RemoteExecManager>,
  identifiers: readonly string[],
): Promise<McpServerDescriptorView[] | undefined> {
  try {
    const response = await accessor.get(mcpStateExecutorResource).execute(ctx, new McpStateExecArgs({ serverIdentifiers: [...identifiers] }))
    const result = (response as { readonly result?: { readonly case?: string; readonly value?: { readonly servers?: readonly unknown[] } } }).result
    if (result?.case !== "success") return undefined
    return (result.value?.servers ?? []).map((value) => {
      const server = value as {
        readonly serverIdentifier?: unknown
        readonly serverName?: unknown
        readonly plugin?: unknown
        readonly marketplace?: unknown
        readonly instructions?: readonly { readonly instructions?: unknown }[]
        readonly tools?: readonly unknown[]
        readonly status?: unknown
      }
      const instructions = (server.instructions ?? [])
        .map((entry) => entry.instructions)
        .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        .join("\n")
      return {
        serverIdentifier: typeof server.serverIdentifier === "string" ? server.serverIdentifier : "",
        serverName: typeof server.serverName === "string" ? server.serverName : "",
        ...(typeof server.plugin === "string" ? { plugin: server.plugin } : {}),
        ...(typeof server.marketplace === "string" ? { marketplace: server.marketplace } : {}),
        ...(instructions.length === 0 ? {} : { serverUseInstructions: instructions }),
        tools: (server.tools ?? []).map(toolView),
        ...(typeof server.status === "string" ? { status: server.status } : {}),
      }
    })
  } catch {
    return undefined
  }
}

/** Serializes a Slate result view into the generated GetMcpTools result union. */
export function createGetMcpToolsResultInterop(value: GetMcpToolsResultView): unknown {
  if (value.kind === "unknown") return new GetMcpToolsAgentResult()
  if (value.kind === "error") return new GetMcpToolsAgentResult({ result: { case: "error", value: new GetMcpToolsError({ error: value.error }) } })
  return new GetMcpToolsAgentResult({
    result: { case: "success", value: new GetMcpToolsSuccess({ content: value.content, ...(value.outputFilePath === undefined ? {} : { outputFilePath: value.outputFilePath }) }) },
  })
}

export function projectGetMcpToolsResultInterop(value: unknown): GetMcpToolsResultView {
  const result = (value as GetMcpToolsAgentResult | undefined)?.result
  if (result?.case === "success") {
    return {
      kind: "success",
      content: result.value.content,
      ...(result.value.outputFilePath === undefined ? {} : { outputFilePath: result.value.outputFilePath }),
    }
  }
  if (result?.case === "error") return { kind: "error", error: result.value.error }
  return { kind: "unknown" }
}

/** Constructs the generated tool-call carrier around a Slate discovery request/result. */
export function createGetMcpToolsToolCallInterop(
  toolCallId: string,
  request: GetMcpToolsRequestView,
  result?: GetMcpToolsResultView,
): unknown {
  const args = new GetMcpToolsArgs({
    ...(request.server === undefined ? {} : { server: request.server }),
    ...(request.toolName === undefined ? {} : { toolName: request.toolName }),
    ...(request.pattern === undefined ? {} : { pattern: request.pattern }),
    toolCallId,
  })
  const resultMessage = result === undefined ? undefined : createGetMcpToolsResultInterop(result) as GetMcpToolsAgentResult
  return new ToolCall({
    tool: {
      case: "getMcpToolsToolCall",
      value: new GetMcpToolsToolCall({ args, ...(resultMessage === undefined ? {} : { result: resultMessage }) }),
    },
  })
}
