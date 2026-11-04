/** Projects generated MCP call/result messages to and from Slate tool outcomes. */
import {
  McpSuccess,
  McpTextContent,
  McpToolResultContentItem,
  type McpResult,
} from "../proto/generated/agent/v1/mcp_exec_pb.ts"
import { McpToolCall, McpToolResult } from "../proto/generated/agent/v1/mcp_tool_pb.ts"
import { ToolCall } from "../proto/generated/agent/v1/agent_pb.ts"
import { ASK_MODE_MODEL_ERROR } from "../../../packages/agent/tools/tool-support.ts"
import { ToolCallRejectedError } from "../../../packages/agent/tools/tool-errors.ts"
import {
  createMcpTransportError,
  getWrappedMcpErrorClassification,
  isInvalidMcpArgumentsError,
  McpInvalidArgsToolDefinitionReminderError,
  McpPermissionDeniedError,
  McpServerDoesNotExistError,
  McpWithoutReadToolDefinitionError,
  throwMcpMissingServer,
  throwMcpMissingTool,
} from "../../../packages/agent/tools/mcp/mcp-result-boundary.ts"

export function createMcpToolCall(mcpToolCall: McpToolCall): ToolCall {
  return new ToolCall({ tool: { case: "mcpToolCall", value: mcpToolCall } })
}

export function convertExecSuccessToToolSuccess(
  answer: unknown,
  readReminder: string | undefined,
  invalidArgsReminder: string | undefined,
  fileOptions: { readonly enabled: boolean; readonly workspaceProjectDir: string } | undefined,
  toolsToolName: string | undefined,
  requestedServer?: string,
): McpToolResult {
  const result = (answer as McpResult).result
  if (result.case !== "success") {
    switch (result.case) {
      case "error": {
        const classifiedError = createMcpTransportError(result.value.error)
        if (readReminder !== undefined) {
          throw new McpWithoutReadToolDefinitionError(
            classifiedError,
            readReminder,
            getWrappedMcpErrorClassification(classifiedError),
          )
        }
        if (invalidArgsReminder !== undefined && isInvalidMcpArgumentsError(classifiedError)) {
          throw new McpInvalidArgsToolDefinitionReminderError(classifiedError, invalidArgsReminder)
        }
        throw classifiedError
      }
      case "rejected":
        throw new ToolCallRejectedError(result.value.reason || "Tool rejected")
      case "permissionDenied":
        throw new McpPermissionDeniedError(result.value.error, result.value.isReadonly)
      case "toolNotFound": {
        const { name: tool, availableTools } = result.value
        if (requestedServer && availableTools.length > 0) {
          const serverPrefix = `${requestedServer}-`
          const serverHasAnyTools = availableTools.some(candidate => candidate.startsWith(serverPrefix))
          if (!serverHasAnyTools) {
            const guidance = fileOptions?.enabled
              ? "Read the MCP server descriptor files to discover available servers."
              : `Use ${toolsToolName ?? "GetMcpTools"} to discover available servers.`
            throw new McpServerDoesNotExistError(requestedServer, guidance)
          }
        }
        throwMcpMissingTool(fileOptions, tool, toolsToolName)
      }
      case "serverNotFound": {
        const { name: server, availableServers } = result.value
        throwMcpMissingServer(fileOptions, server, availableServers, toolsToolName)
      }
      case "approved":
        throw new Error("Approval-only MCP result cannot be used as tool output")
      case undefined:
        throw new Error("Exec result has no case")
      default: {
        const exhaustiveResult: never = result
        throw new Error(`Unexpected exec result case: ${exhaustiveResult}`)
      }
    }
  }
  return new McpToolResult({ result: { case: "success", value: result.value } })
}

function textItem(text: string): McpToolResultContentItem {
  return new McpToolResultContentItem({ content: { case: "text", value: new McpTextContent({ text }) } })
}

export function createVirtualMcpAuthSuccessResult(serverId: string): McpToolResult {
  return new McpToolResult({
    result: {
      case: "success",
      value: new McpSuccess({
        content: [textItem(`Successfully authenticated MCP server: ${serverId}. The server's tools should now be available.`)],
        isError: false,
      }),
    },
  })
}

interface Rendered {
  readonly type: "text" | "image"
  readonly text?: string
  readonly data?: string
  readonly mimeType?: string
}

function describeOutputLocation(location: { readonly filePath: string; readonly sizeBytes: unknown; readonly lineCount: unknown }): string {
  const totalSize = Number(location.sizeBytes)
  const lineCount = Number(location.lineCount)
  const size = totalSize >= 1024 ? `${(totalSize / 1024).toFixed(1)} KB` : `${totalSize} bytes`
  return `Large output has been written to: ${location.filePath} (${size}, ${lineCount} lines)`
}

function renderContentItem(item: McpToolResultContentItem): Rendered {
  switch (item.content.case) {
    case "text": {
      const textContent = item.content.value
      if (textContent.outputLocation) return { type: "text", text: describeOutputLocation(textContent.outputLocation) }
      return { type: "text", text: textContent.text }
    }
    case "image":
      return {
        type: "image",
        data: Buffer.from(item.content.value.data).toString("base64"),
        mimeType: item.content.value.mimeType,
      }
    case undefined:
      throw new Error("Unhandled content case: undefined")
    default: {
      const exhaustiveContent: never = item.content
      throw new Error(`Unhandled content case: ${exhaustiveContent}`)
    }
  }
}

export function renderMcpToolResult(result: McpToolResult): {
  readonly content: Rendered[]
  readonly isError?: boolean
} {
  const answer = result.result
  switch (answer.case) {
    case "success":
      return { content: answer.value.content.map(renderContentItem), isError: answer.value.isError }
    case "rejected":
      return { content: [{ type: "text", text: answer.value.reason ? `Tool rejected: ${answer.value.reason}` : "Tool rejected" }] }
    case "error":
      return {
        content: [{
          type: "text",
          text: answer.value.readToolDefReminder
            ? `Error: ${answer.value.error}. ${answer.value.readToolDefReminder}`
            : `Error: ${answer.value.error}`,
        }],
      }
    case "permissionDenied":
      return { content: [{ type: "text", text: answer.value.isReadonly ? ASK_MODE_MODEL_ERROR : `Permission denied: ${answer.value.error}` }] }
    case undefined:
      return { content: [{ type: "text", text: "Unknown error" }] }
    default: {
      const exhaustiveResult: never = answer
      throw new Error(`Unhandled result case: ${exhaustiveResult}`)
    }
  }
}

/** Accepts the opaque value carried by the Slate tool port and normalizes it at the wire boundary. */
export function renderMcpToolResultInterop(value: unknown): {
  readonly content: Rendered[]
  readonly isError?: boolean
} {
  if (value instanceof McpToolResult) return renderMcpToolResult(value)
  if (typeof value === "object" && value !== null) {
    const nested = (value as { readonly result?: unknown }).result
    if (nested instanceof McpToolResult) return renderMcpToolResult(nested)
  }
  return renderMcpToolResult(new McpToolResult())
}
