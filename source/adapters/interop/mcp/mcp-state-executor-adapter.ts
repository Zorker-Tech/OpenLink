import { Value, type JsonValue as ProtobufJsonValue } from "@bufbuild/protobuf"
import type { JsonValue } from "@slate/work-domain"
import { McpStateExecResult, McpStateServer, McpStateSuccess } from "../proto/generated/agent/v1/mcp_exec_pb.ts"
import { McpToolDefinition } from "../proto/generated/agent/v1/mcp_pb.ts"

export interface SlateMcpTool {
  readonly providerIdentifier: string
  readonly name: string
  readonly toolName: string
  readonly description?: string | undefined
  readonly inputSchema?: JsonValue | undefined
}

export interface SlateMcpProvider {
  getTools(context: unknown): Promise<readonly SlateMcpTool[]>
}

/** Encode Slate's discovered tools as the state-executor response expected by the counterpart protocol. */
export function createMcpStateExecutorAdapter(provider: SlateMcpProvider) {
  return {
    async execute(context: unknown): Promise<McpStateExecResult> {
      const tools = await provider.getTools(context)
      const providers = groupToolsByProvider(tools)
      const servers = [...providers].map(([identifier, providerTools]) => toWireServer(identifier, providerTools))
      return new McpStateExecResult({
        result: {
          case: "success",
          value: new McpStateSuccess({ servers }),
        },
      })
    },
  }
}

function groupToolsByProvider(tools: readonly SlateMcpTool[]): Map<string, SlateMcpTool[]> {
  const groups = new Map<string, SlateMcpTool[]>()
  for (const tool of tools) {
    const group = groups.get(tool.providerIdentifier)
    if (group === undefined) groups.set(tool.providerIdentifier, [tool])
    else group.push(tool)
  }
  return groups
}

function toWireServer(identifier: string, tools: readonly SlateMcpTool[]): McpStateServer {
  return new McpStateServer({
    serverIdentifier: identifier,
    serverName: identifier,
    status: "connected",
    tools: tools.map(toWireTool),
  })
}

function toWireTool(tool: SlateMcpTool): McpToolDefinition {
  return new McpToolDefinition({
    name: tool.name,
    providerIdentifier: tool.providerIdentifier,
    toolName: tool.toolName,
    description: tool.description!,
    inputSchema: (
      tool.inputSchema === undefined
        ? undefined
        : Value.fromJson(tool.inputSchema as ProtobufJsonValue)
    )!,
  })
}
