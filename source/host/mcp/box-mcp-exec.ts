/**
 * Running an MCP tool on a box.
 *
 * The call is carried to the box's own MCP bridge and its answer is turned back into the result the tool layer takes,
 * with a box that cannot run it reported as such rather than as an empty answer.
 */
import {
  McpArgs,
  McpError,
  McpResult,
  McpStateExecArgs,
  McpStateExecResult
} from "../../packages/proto/generated/agent/v1/mcp_exec_pb.ts";
import { mcpExecutorResource, mcpStateExecutorResource } from "../../packages/agent-exec/mcp-operations.ts";
import type { ResourceAccessor } from "../../packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../packages/agent-exec/executor-resources.ts";
import { createContext } from "../../packages/context/context.ts";
import { recordMcpExecErrorClass } from "../../shared/node/mcp/mcp-diagnostics.ts";
import {
  boxLoadMcpServers,
  boxMcpResourceAccessor,
  type CapableBox
} from "../boxes/box-capabilities.ts";

export class BoxMcpExecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoxMcpExecError";
  }
}

export interface BoxMcpTool {
  name: string;
  providerIdentifier: string;
  toolName: string;
  description?: string;
  inputSchema?: unknown;
}

export interface BoxMcpExecPort {
  loadServers(configJson: string): Promise<void>;
  listTools(
    serverIdentifiers: readonly string[],
    options?: { kickOnly?: boolean }
  ): Promise<Array<{
    serverIdentifier: string;
    status: string;
    statusDetail?: string;
    toolCount: number;
    tools: Array<BoxMcpTool & { clientKey: string }>;
  }>>;
  executeTool(args: McpArgs): Promise<McpResult>;
}

export function errorLabel(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

function errorResult(message: string): McpResult {
  return new McpResult({
    result: { case: "error", value: new McpError({ error: message }) }
  });
}

type McpAccessor = ResourceAccessor<RemoteExecManager>;

export function createBoxSlateMcpExec(box: CapableBox): BoxMcpExecPort {
  const ctx = createContext().withName("boxMcp");
  return {
    async loadServers(configJson) {
      await boxLoadMcpServers(box, ctx, configJson);
    },
    async listTools(serverIdentifiers, options) {
      const accessor = await boxMcpResourceAccessor(box, ctx) as McpAccessor;
      const result = await accessor.get(mcpStateExecutorResource).execute(
        ctx,
        new McpStateExecArgs({
          serverIdentifiers: [...serverIdentifiers],
          kickOnly: options?.kickOnly === true
        })
      );
      if (result.result.case !== "success") {
        throw new BoxMcpExecError(
          `Box MCP tool discovery failed: ${result.result.case ?? "empty result"}`
        );
      }
      const requested = new Set(serverIdentifiers);
      return result.result.value.servers
        .filter(server => requested.size === 0 || requested.has(server.serverIdentifier))
        .map(server => ({
          serverIdentifier: server.serverIdentifier,
          status: server.status ?? "connected",
          ...(server.errorMessage == null || server.errorMessage.length === 0
            ? {}
            : { statusDetail: server.errorMessage }),
          toolCount: server.tools.length,
          tools: server.tools.map(tool => ({
            name: tool.name,
            providerIdentifier: tool.providerIdentifier,
            toolName: tool.toolName,
            clientKey: server.serverIdentifier,
            ...(tool.description.length === 0 ? {} : { description: tool.description }),
            ...(tool.inputSchema == null ? {} : { inputSchema: tool.inputSchema.toJson() })
          }))
        }));
    },
    async executeTool(args) {
      try {
        const accessor = await boxMcpResourceAccessor(box, ctx) as McpAccessor;
        return await accessor.get(mcpExecutorResource).execute(ctx, args);
      } catch (error) {
        recordMcpExecErrorClass(args.toolCallId, error);
        return errorResult(
          `Box MCP execution failed for "${args.name}": ${errorLabel(error)}`
        );
      }
    }
  };
}
