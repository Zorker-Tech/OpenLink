/**
 * Turning what an MCP server did into what the turn can show.
 *
 * A server answers in its own terms, and almost none of them are the terms the rest of the turn works in.
 * A result arrives as one of a handful of cases, and each has to become either a tool result the model can
 * read or an error the model can act on: a permission refusal, a tool that does not exist, a server that
 * does not exist, a transport failure. The difference matters, because the guidance a model needs differs —
 * "the server is not there" is answered by listing the servers, "the tool is not there" by reading the
 * tool's definition file first, and a refusal by telling the user what to change. So the errors here are
 * classes rather than strings, each carrying the classification the orchestrator retries on and the text
 * each audience should see.
 *
 * The other half is rendering: a result's content items are text or images, and a text item that is too
 * large to have been sent is a pointer to the file it was written to instead. That pointer is rendered as
 * a sentence naming the file, its size and its line count, which is what lets the model decide whether to
 * read it.
 */

import {
  McpSuccess,
  McpTextContent,
  McpToolResultContentItem,
  type McpResult,
} from "../../../proto/generated/agent/v1/mcp_exec_pb.ts"
import { McpToolCall, McpToolResult } from "../../../proto/generated/agent/v1/mcp_tool_pb.ts"
import { ToolCall } from "../../../proto/generated/agent/v1/agent_pb.ts"
import { ASK_MODE_MODEL_ERROR } from "../tool-support.ts"
import { CustomToolCallError, ToolCallRejectedError, ToolErrorClassification } from "../tool-errors.ts"
import { classifyMcpErrorMessage } from "./mcp-error-classification.ts"

/** A refusal, which reads differently when the session cannot edit anything at all. */
export class McpPermissionDeniedError extends CustomToolCallError {
  readonly error: string
  readonly isReadonly: boolean

  constructor(error: string, isReadonly: boolean) {
    super(ToolErrorClassification.UNEXPECTED_ENVIRONMENT, {
      error,
      clientVisibleErrorMessage: isReadonly
        ? "You are in ask mode and cannot run non read-only tools. Ask the user to switch to agent mode if edits are required."
        : `Permission denied: ${error}`,
      modelVisibleErrorMessage: isReadonly
        ? "You are in ask mode and cannot run non read-only tools. Ask the user to switch to agent mode if edits are required."
        : `Permission denied: ${error}`,
    })
    this.error = error
    this.isReadonly = isReadonly
  }
}

export class McpServerDoesNotExistError extends CustomToolCallError {
  readonly serverIdentifier: string
  readonly readServerDefReminder: string

  constructor(serverIdentifier: string, readServerDefReminder: string) {
    super(ToolErrorClassification.UNEXPECTED_ENVIRONMENT, {
      error: `MCP server does not exist: ${serverIdentifier}`,
      clientVisibleErrorMessage: `MCP server does not exist: ${serverIdentifier}`,
      modelVisibleErrorMessage: `MCP server does not exist: ${serverIdentifier}. ${readServerDefReminder}`,
    })
    this.serverIdentifier = serverIdentifier
    this.readServerDefReminder = readServerDefReminder
  }
}

export class McpToolDoesNotExistError extends CustomToolCallError {
  readonly serverIdentifier: string
  readonly toolName: string
  readonly readToolDefReminder: string

  constructor(serverIdentifier: string, toolName: string, readToolDefReminder: string) {
    super(ToolErrorClassification.UNEXPECTED_ENVIRONMENT, {
      error: `MCP tool does not exist: server=${serverIdentifier}, tool=${toolName}`,
      clientVisibleErrorMessage: `MCP tool does not exist: ${toolName}`,
      modelVisibleErrorMessage: "unused",
    })
    this.serverIdentifier = serverIdentifier
    this.toolName = toolName
    this.readToolDefReminder = readToolDefReminder
  }
}

export class McpExecToolNotFoundError extends CustomToolCallError {
  constructor(errorMessage: string) {
    super(ToolErrorClassification.UNEXPECTED_ENVIRONMENT, {
      error: errorMessage,
      clientVisibleErrorMessage: errorMessage,
      modelVisibleErrorMessage: errorMessage,
    })
  }
}

/** A failure whose useful part is the reminder that the tool was never looked up first. */
export class McpWithoutReadToolDefinitionError extends CustomToolCallError {
  readonly error: unknown
  readonly readToolDefReminder: string

  constructor(
    error: unknown,
    readToolDefReminder: string,
    classification: ToolErrorClassification = ToolErrorClassification.OTHER_ERROR,
  ) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    super(classification, {
      error: `Error in call_mcp_tool: ${errorMessage} without reading the tool definition`,
      clientVisibleErrorMessage: "Tool execution error",
      modelVisibleErrorMessage: `${errorMessage}. ${readToolDefReminder}`,
    })
    this.error = error
    this.readToolDefReminder = readToolDefReminder
  }
}

/** Bad arguments, told apart from other failures so the caller can ask for the definition. */
export class McpInvalidArgsToolDefinitionReminderError extends CustomToolCallError {
  constructor(error: Error, readToolDefReminder: string) {
    super(ToolErrorClassification.INVALID_ARGS, {
      error: error.message,
      clientVisibleErrorMessage: "Tool execution error",
      modelVisibleErrorMessage: `${error.message}. ${readToolDefReminder}`,
    })
  }
}

export function getWrappedMcpErrorClassification(error: unknown): ToolErrorClassification {
  return error instanceof CustomToolCallError
    ? error.classification
    : ToolErrorClassification.OTHER_ERROR
}

export function isInvalidMcpArgumentsError(error: unknown): boolean {
  return getWrappedMcpErrorClassification(error) === ToolErrorClassification.INVALID_ARGS
}

/**
 * A transport failure is classified when the message says enough to classify it, and otherwise stays a
 * plain error — guessing at a retry policy from a message nobody wrote for it would be worse than not
 * retrying.
 */
export function createMcpTransportError(errorMessage: string, cause?: unknown): Error {
  const classification = classifyMcpErrorMessage(errorMessage)
  if (classification !== undefined && classification !== ToolErrorClassification.OTHER_ERROR) {
    return new CustomToolCallError(classification, {
      error: errorMessage,
      clientVisibleErrorMessage: errorMessage,
      modelVisibleErrorMessage: errorMessage,
    })
  }
  return new Error(errorMessage, { cause })
}

export function createMcpToolCall(mcpToolCall: McpToolCall): ToolCall {
  return new ToolCall({
    tool: {
      case: "mcpToolCall",
      value: mcpToolCall,
    },
  })
}

export function convertExecSuccessToToolSuccess(
  execResult: McpResult,
  readToolDefReminder: string | undefined,
  invalidArgsToolDefReminder: string | undefined,
  mcpFileSystemOptions: { readonly enabled: boolean; readonly workspaceProjectDir: string } | undefined,
  getMcpToolsToolName: string | undefined,
  requestedServer?: string,
): McpToolResult {
  if (execResult.result.case !== "success") {
    switch (execResult.result.case) {
      case "error": {
        const classifiedError = createMcpTransportError(execResult.result.value.error)
        if (readToolDefReminder !== undefined) {
          throw new McpWithoutReadToolDefinitionError(
            classifiedError,
            readToolDefReminder,
            getWrappedMcpErrorClassification(classifiedError),
          )
        }
        if (invalidArgsToolDefReminder !== undefined && isInvalidMcpArgumentsError(classifiedError)) {
          throw new McpInvalidArgsToolDefinitionReminderError(classifiedError, invalidArgsToolDefReminder)
        }
        throw classifiedError
      }
      case "rejected":
        throw new ToolCallRejectedError(execResult.result.value.reason || "Tool rejected")
      case "permissionDenied":
        throw new McpPermissionDeniedError(execResult.result.value.error, execResult.result.value.isReadonly)
      case "toolNotFound": {
        const { name, availableTools } = execResult.result.value
        // A tool that is missing because its whole server is missing needs the other answer: the servers.
        if (requestedServer && availableTools.length > 0) {
          const serverPrefix = `${requestedServer}-`
          const serverHasAnyTools = availableTools.some(tool => tool.startsWith(serverPrefix))
          if (!serverHasAnyTools) {
            const guidance = mcpFileSystemOptions?.enabled
              ? "Read the MCP server descriptor files to discover available servers."
              : `Use ${getMcpToolsToolName ?? "GetMcpTools"} to discover available servers.`
            throw new McpServerDoesNotExistError(requestedServer, guidance)
          }
        }
        if (mcpFileSystemOptions?.enabled) {
          const mcpsDir = `${mcpFileSystemOptions.workspaceProjectDir}/mcps`
          throw new McpExecToolNotFoundError(
            `Tool ${name} was not found. The list of all available MCP servers are included in ${mcpsDir}. Please list and read the relevant MCP servers carefully before using call_mcp_tool again.`,
          )
        }
        throw new McpExecToolNotFoundError(
          `Tool ${name} was not found. Use ${getMcpToolsToolName ?? "GetMcpTools"} to discover available servers and their tools.`,
        )
      }
      case "serverNotFound": {
        const { name, availableServers } = execResult.result.value
        const readServerDefReminder = availableServers.length > 0
          ? `Available servers: ${availableServers.join(", ")}`
          : mcpFileSystemOptions?.enabled
            ? "No MCP servers available. Read the MCP server descriptor files to discover available servers."
            : `No MCP servers available. Use ${getMcpToolsToolName ?? "GetMcpTools"} to discover available servers.`
        throw new McpServerDoesNotExistError(name, readServerDefReminder)
      }
      case "approved":
        throw new Error("Approval-only MCP result cannot be used as tool output")
      case undefined:
        throw new Error("Exec result has no case")
      default: {
        const exhaustiveResult: never = execResult.result
        throw new Error(`Unexpected exec result case: ${exhaustiveResult}`)
      }
    }
  }
  return new McpToolResult({
    result: {
      case: "success",
      value: execResult.result.value,
    },
  })
}

/** The result of a sign-in, which has no content of its own beyond saying it worked. */
export function createVirtualMcpAuthSuccessResult(serverIdentifier: string): McpToolResult {
  return new McpToolResult({
    result: {
      case: "success",
      value: new McpSuccess({
        content: [
          new McpToolResultContentItem({
            content: {
              case: "text",
              value: new McpTextContent({
                text: `Successfully authenticated MCP server: ${serverIdentifier}. The server's tools should now be available.`,
              }),
            },
          }),
        ],
        isError: false,
      }),
    },
  })
}

interface McpRenderedContent {
  readonly type: "text" | "image"
  readonly text?: string
  readonly data?: string
  readonly mimeType?: string
}

function renderMcpContentItem(item: McpToolResultContentItem): McpRenderedContent {
  switch (item.content.case) {
    case "text": {
      const textContent = item.content.value
      // A text item that was written to a file says where it went instead of carrying the text.
      if (textContent.outputLocation) {
        const totalSize = Number(textContent.outputLocation.sizeBytes)
        const lineCount = Number(textContent.outputLocation.lineCount)
        const size = totalSize >= 1024 ? `${(totalSize / 1024).toFixed(1)} KB` : `${totalSize} bytes`
        return {
          type: "text",
          text: `Large output has been written to: ${textContent.outputLocation.filePath} (${size}, ${lineCount} lines)`,
        }
      }
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
  readonly content: McpRenderedContent[]
  readonly isError?: boolean
} {
  switch (result.result.case) {
    case "success":
      return {
        content: result.result.value.content.map(renderMcpContentItem),
        isError: result.result.value.isError,
      }
    case "rejected":
      return { content: [{ type: "text", text: result.result.value.reason ? `Tool rejected: ${result.result.value.reason}` : "Tool rejected" }] }
    case "error":
      return {
        content: [{
          type: "text",
          text: result.result.value.readToolDefReminder
            ? `Error: ${result.result.value.error}. ${result.result.value.readToolDefReminder}`
            : `Error: ${result.result.value.error}`,
        }],
      }
    case "permissionDenied":
      return { content: [{ type: "text", text: result.result.value.isReadonly ? ASK_MODE_MODEL_ERROR : `Permission denied: ${result.result.value.error}` }] }
    case undefined:
      return { content: [{ type: "text", text: "Unknown error" }] }
    default: {
      const exhaustiveResult: never = result.result
      throw new Error(`Unhandled result case: ${exhaustiveResult}`)
    }
  }
}
