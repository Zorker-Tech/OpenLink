/** Encodes Slate's dynamic built-in tool catalogue and results as MCP messages. */
import { Buffer } from "node:buffer"
import { Value } from "@bufbuild/protobuf"
import {
  McpImageContent,
  McpResult as InteropMcpResult,
  McpSuccess,
  McpTextContent,
  McpToolResultContentItem,
} from "../proto/generated/agent/v1/mcp_exec_pb.ts"
import { McpDescriptor, McpToolDescriptor } from "../proto/generated/agent/v1/mcp_pb.ts"
import type { SlateMcpDescriptor } from "../../../packages/agent/tools/mcp/builtin-tools.ts"

export function createInteropMcpDescriptor(descriptor: SlateMcpDescriptor): McpDescriptor {
  return new McpDescriptor({
    serverIdentifier: descriptor.serverIdentifier,
    serverName: descriptor.serverName,
    serverUseInstructions: descriptor.serverUseInstructions,
    tools: descriptor.tools.map(tool => {
      const inputSchema = tool.inputSchema === undefined
        ? undefined
        : tool.inputSchema instanceof Value
          ? tool.inputSchema
          : Value.fromJson(tool.inputSchema as never)
      return new McpToolDescriptor({
        toolName: tool.toolName,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(inputSchema === undefined ? {} : { inputSchema }),
      })
    }),
  })
}

/** Projects the platform's tool result to the MCP result message. */
export function encodeInteropMcpToolResult(toolResult: {
  readonly content: readonly { readonly type: string; readonly text?: string | undefined; readonly data?: string | undefined; readonly mimeType?: string | undefined }[]
  readonly isError?: boolean | undefined
}): InteropMcpResult {
  const contentItems = toolResult.content.map(entry => {
    if (entry.type === "text") {
      return new McpToolResultContentItem({ content: { case: "text", value: new McpTextContent({ text: entry.text! }) } })
    }
    if (entry.type === "image") {
      return new McpToolResultContentItem({
        content: {
          case: "image",
          value: new McpImageContent({ data: Buffer.from(entry.data!, "base64"), mimeType: entry.mimeType ?? "image/png" }),
        },
      })
    }
    return new McpToolResultContentItem({
      content: { case: "text", value: new McpTextContent({ text: JSON.stringify(entry) }) },
    })
  })
  return new InteropMcpResult({
    result: { case: "success", value: new McpSuccess({ content: contentItems, isError: toolResult.isError as boolean }) },
  })
}
