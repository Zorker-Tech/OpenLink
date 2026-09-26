/**
 * Reporting the MCP servers an agent has, in the shape the state executor answers with.
 *
 * The tools are grouped by the server they came from, and each server is reported as connected with the definitions its
 * provider declared.
 */
import { Value, type JsonValue } from "@bufbuild/protobuf";
import { McpStateExecResult, McpStateServer, McpStateSuccess } from "../../packages/proto/generated/agent/v1/mcp_exec_pb.ts";
import { McpToolDefinition } from "../../packages/proto/generated/agent/v1/mcp_pb.ts";

export interface SlateMcpTool { providerIdentifier: string; name: string; toolName: string; description?: string; inputSchema?: JsonValue }
export interface SlateMcpProvider { getTools(ctx: unknown): Promise<readonly SlateMcpTool[]> }
export function createSlateMcpStateExecutor(provider: SlateMcpProvider) { return { async execute(ctx: unknown): Promise<McpStateExecResult> { const grouped = new Map<string, SlateMcpTool[]>(); for (const tool of await provider.getTools(ctx)) { const tools = grouped.get(tool.providerIdentifier); if (tools === undefined) grouped.set(tool.providerIdentifier, [tool]); else tools.push(tool); } const servers = [...grouped].map(([serverIdentifier, tools]) => new McpStateServer({ serverIdentifier, serverName: serverIdentifier, status: "connected", tools: tools.map((tool) => new McpToolDefinition({ name: tool.name, providerIdentifier: tool.providerIdentifier, toolName: tool.toolName, description: tool.description!, inputSchema: (tool.inputSchema === undefined ? undefined : Value.fromJson(tool.inputSchema))! })) })); return new McpStateExecResult({ result: { case: "success", value: new McpStateSuccess({ servers }) } }); } }; }
