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

/** The three texts a tool error carries, built from the texts its audience sees. */
function textsFor(error: string, clientVisibleErrorMessage: string, modelVisibleErrorMessage: string): {
  readonly error: string
  readonly clientVisibleErrorMessage: string
  readonly modelVisibleErrorMessage: string
} {
  return { error, clientVisibleErrorMessage, modelVisibleErrorMessage }
}

/** The same text for every audience. */
function sameTextForAll(error: string): ReturnType<typeof textsFor> {
  return textsFor(error, error, error)
}

/** A refusal, which reads differently when the session cannot edit anything at all. */
export class McpPermissionDeniedError extends CustomToolCallError {
  readonly error: string
  readonly isReadonly: boolean

  constructor(message: string, readonly: boolean) {
    const refusal = readonly ? ASK_MODE_MODEL_ERROR : `Permission denied: ${message}`
    super(ToolErrorClassification.UNEXPECTED_ENVIRONMENT, textsFor(message, refusal, refusal))
    this.error = message
    this.isReadonly = readonly
  }
}

export class McpServerDoesNotExistError extends CustomToolCallError {
  readonly serverIdentifier: string
  readonly readServerDefReminder: string

  constructor(serverId: string, reminder: string) {
    const missing = `MCP server does not exist: ${serverId}`
    super(ToolErrorClassification.UNEXPECTED_ENVIRONMENT, textsFor(missing, missing, `${missing}. ${reminder}`))
    this.serverIdentifier = serverId
    this.readServerDefReminder = reminder
  }
}

export class McpToolDoesNotExistError extends CustomToolCallError {
  readonly serverIdentifier: string
  readonly toolName: string
  readonly readToolDefReminder: string

  constructor(serverId: string, tool: string, reminder: string) {
    super(
      ToolErrorClassification.UNEXPECTED_ENVIRONMENT,
      textsFor(`MCP tool does not exist: server=${serverId}, tool=${tool}`, `MCP tool does not exist: ${tool}`, "unused"),
    )
    this.serverIdentifier = serverId
    this.toolName = tool
    this.readToolDefReminder = reminder
  }
}

export class McpExecToolNotFoundError extends CustomToolCallError {
  constructor(message: string) {
    super(ToolErrorClassification.UNEXPECTED_ENVIRONMENT, sameTextForAll(message))
  }
}

/** A failure whose useful part is the reminder that the tool was never looked up first. */
export class McpWithoutReadToolDefinitionError extends CustomToolCallError {
  readonly error: unknown
  readonly readToolDefReminder: string

  constructor(
    failure: unknown,
    reminder: string,
    kind: ToolErrorClassification = ToolErrorClassification.OTHER_ERROR,
  ) {
    const message = failure instanceof Error ? failure.message : String(failure)
    super(kind, textsFor(
      `Error in call_mcp_tool: ${message} without reading the tool definition`,
      "Tool execution error",
      `${message}. ${reminder}`,
    ))
    this.error = failure
    this.readToolDefReminder = reminder
  }
}

/** Bad arguments, told apart from other failures so the caller can ask for the definition. */
export class McpInvalidArgsToolDefinitionReminderError extends CustomToolCallError {
  constructor(failure: Error, reminder: string) {
    super(ToolErrorClassification.INVALID_ARGS, textsFor(
      failure.message,
      "Tool execution error",
      `${failure.message}. ${reminder}`,
    ))
  }
}

export function getWrappedMcpErrorClassification(failure: unknown): ToolErrorClassification {
  return failure instanceof CustomToolCallError
    ? failure.classification
    : ToolErrorClassification.OTHER_ERROR
}

export function isInvalidMcpArgumentsError(failure: unknown): boolean {
  return getWrappedMcpErrorClassification(failure) === ToolErrorClassification.INVALID_ARGS
}

/**
 * A transport failure is classified when the message says enough to classify it, and otherwise stays a
 * plain error — guessing at a retry policy from a message nobody wrote for it would be worse than not
 * retrying.
 */
export function createMcpTransportError(message: string, cause?: unknown): Error {
  const classification = classifyMcpErrorMessage(message)
  if (classification !== undefined && classification !== ToolErrorClassification.OTHER_ERROR) {
    return new CustomToolCallError(classification, sameTextForAll(message))
  }
  return new Error(message, { cause })
}

export function createMcpToolCall(mcpToolCall: McpToolCall): ToolCall {
  return new ToolCall({
    tool: {
      case: "mcpToolCall",
      value: mcpToolCall,
    },
  })
}

/** The answer for a missing tool: the descriptor files, or the tool that lists the servers. */
function throwMissingTool(
  fileOptions: { readonly enabled: boolean; readonly workspaceProjectDir: string } | undefined,
  tool: string,
  toolsToolName: string | undefined,
): never {
  if (fileOptions?.enabled) {
    const mcpsDir = `${fileOptions.workspaceProjectDir}/mcps`
    throw new McpExecToolNotFoundError(
      `Tool ${tool} was not found. The list of all available MCP servers are included in ${mcpsDir}. Please list and read the relevant MCP servers carefully before using call_mcp_tool again.`,
    )
  }
  throw new McpExecToolNotFoundError(
    `Tool ${tool} was not found. Use ${toolsToolName ?? "GetMcpTools"} to discover available servers and their tools.`,
  )
}

/** The answer for a missing server: the servers to read, or the tool that lists them. */
function throwMissingServer(
  fileOptions: { readonly enabled: boolean; readonly workspaceProjectDir: string } | undefined,
  server: string,
  availableServers: readonly string[],
  toolsToolName: string | undefined,
): never {
  const reminder = availableServers.length > 0
    ? `Available servers: ${availableServers.join(", ")}`
    : fileOptions?.enabled
      ? "No MCP servers available. Read the MCP server descriptor files to discover available servers."
      : `No MCP servers available. Use ${toolsToolName ?? "GetMcpTools"} to discover available servers.`
  throw new McpServerDoesNotExistError(server, reminder)
}

export function convertExecSuccessToToolSuccess(
  answer: McpResult,
  readReminder: string | undefined,
  invalidArgsReminder: string | undefined,
  fileOptions: { readonly enabled: boolean; readonly workspaceProjectDir: string } | undefined,
  toolsToolName: string | undefined,
  requestedServer?: string,
): McpToolResult {
  const result = answer.result
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
        // A tool that is missing because its whole server is missing needs the other answer: the servers.
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
        throwMissingTool(fileOptions, tool, toolsToolName)
      }
      case "serverNotFound": {
        const { name: server, availableServers } = result.value
        throwMissingServer(fileOptions, server, availableServers, toolsToolName)
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
  return new McpToolResult({
    result: {
      case: "success",
      value: result.value,
    },
  })
}

/** A text content item, the shape every successful answer is made of. */
function textItem(text: string): McpToolResultContentItem {
  return new McpToolResultContentItem({
    content: {
      case: "text",
      value: new McpTextContent({ text }),
    },
  })
}

/** The result of a sign-in, which has no content of its own beyond saying it worked. */
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

/** The sentence a text item that was written to a file is rendered as. */
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
      // A text item that was written to a file says where it went instead of carrying the text.
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
      return {
        content: answer.value.content.map(renderContentItem),
        isError: answer.value.isError,
      }
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
