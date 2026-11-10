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

import { ASK_MODE_MODEL_ERROR } from "../tool-support.ts"
import { CustomToolCallError, ToolErrorClassification } from "../tool-errors.ts"
import { classifyMcpErrorMessage } from "./error-classification.ts"

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

/** The answer for a missing tool: the descriptor files, or the tool that lists the servers. */
export function throwMcpMissingTool(
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
export function throwMcpMissingServer(
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
