/**
 * Repairing the conversation after a turn was interrupted mid-tool-call.
 *
 * A turn that is stopped while a tool is running leaves the conversation in a state no provider will
 * accept: the assistant message asks for a tool call, and no tool result ever answers it. Before the
 * conversation is sent again, every such pending message is read back, each unanswered tool call is given
 * the result it would have had, and the whole set is appended as the tool message that closes them.
 *
 * What that result says depends on what was interrupted. A wait is reported as interrupted after however
 * long it had been running; a shell command is reported with the output that was collected before the
 * interruption, when the session still has it, since that output is often the only record of what the
 * command had done; a subagent is reported through the same rendering a finished one gets, because the
 * host may already have recorded its result. Everything else is reported by name.
 *
 * The host's own record of the interruption is preferred where it exists, and the reconstructed text is
 * only the fallback. The elapsed time comes from the tool call's own start time, so a conversation
 * restored much later still says how long the call had run rather than how long ago it was made.
 */

import { PrivacyCapability } from "../../../redaction/classification.ts"
import { toRedactedCoreMessages } from "../../../redaction/message-redaction.ts"
import { fromRedactedInterruptedPendingToolCallResolution } from "../../../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { getExecutableTools } from "../../tools/tool-execution.ts"
import { renderShellResultToString, formatShellPartialOutputSection } from "../../tools/core/shell/formatters.ts"
import { renderTaskResultToString } from "../../tools/task-client.ts"
import { getInterruptedShellOutputSnapshot, clearInterruptedShellOutputSnapshot } from "../../tools/core/shell/interrupted-shell-output.ts"
import type { PrivacyMode } from "../../../redaction/privacy-mode.ts"

interface RedactedPendingMessage {
  unwrap(purpose: PrivacyCapability): string
}

interface InterruptedToolStateHandler {
  getRawPendingMessages(): readonly RedactedPendingMessage[] | undefined
  getPrivacyMode(): PrivacyMode
}

interface ToolLike {
  readonly name: string
  readonly toolIdentifier?: string | undefined
}

interface ParsedPendingMessage {
  readonly [key: string]: unknown
  readonly role: string
  readonly content: unknown
  readonly providerOptions?: {
    readonly cursor?: {
      readonly pendingToolCallStartedAtMs?: unknown
      readonly highLevelToolCallResult?: unknown
    } | undefined
  } | undefined
}

type RedactedInterruptedResolution = Parameters<typeof fromRedactedInterruptedPendingToolCallResolution>[0]
type RedactedInterruptedResolutions = {
  readonly resolutions: readonly RedactedInterruptedResolution[]
}

function getPendingToolCallElapsedMs(message: {
  readonly providerOptions?: {
    readonly cursor?: { readonly pendingToolCallStartedAtMs?: unknown } | undefined
  } | undefined
}): number | undefined {
  const startedAtMs = message.providerOptions?.cursor?.pendingToolCallStartedAtMs
  if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs)) return undefined
  return Math.max(0, Date.now() - startedAtMs)
}

function formatElapsedText(elapsedMs: number | undefined): string {
  return elapsedMs !== undefined ? ` after ${elapsedMs}ms` : ""
}

function formatInterruptedAwaitResult(elapsedMs: number | undefined): string {
  return `Error: Await was interrupted by the user${formatElapsedText(elapsedMs)}.`
}

/** The output a shell command had produced before it was stopped is worth keeping, so it is quoted. */
function formatInterruptedShellResult(args: { readonly toolCallId: string; readonly elapsedMs: number | undefined }): string {
  const snapshot = getInterruptedShellOutputSnapshot(args.toolCallId)
  clearInterruptedShellOutputSnapshot(args.toolCallId)
  const elapsedText = formatElapsedText(args.elapsedMs)
  if (snapshot === undefined || snapshot.length === 0) {
    return `Error: Shell command was interrupted by the user${elapsedText} before it completed.`
  }
  const partialOutputSection = formatShellPartialOutputSection(snapshot, {
    heading: "Output collected before interruption",
    truncatedSuffix: " (truncated)",
  })
  return `Error: Shell command was interrupted by the user${elapsedText} before it completed.\n\n${partialOutputSection}`
}

function formatInterruptedToolResult(args: {
  readonly toolIdentifier: string
  readonly toolCallId: string
  readonly toolName: string
  readonly elapsedMs: number | undefined
}): string {
  switch (args.toolIdentifier) {
    case "AWAIT": return formatInterruptedAwaitResult(args.elapsedMs)
    case "SHELL": return formatInterruptedShellResult({ toolCallId: args.toolCallId, elapsedMs: args.elapsedMs })
    default: return `Error: ${args.toolName} was interrupted by the user${formatElapsedText(args.elapsedMs)} before it completed.`
  }
}

/** The host's own record of what the interrupted call produced, rendered as the result the model reads. */
function formatResolvedInterruptedToolCall(args: {
  readonly resolution: RedactedInterruptedResolution | undefined
  readonly terminalsFolder: string | undefined
}): { readonly result: string; readonly isError: boolean } | undefined {
  if (args.resolution === undefined) return undefined
  const resolution = fromRedactedInterruptedPendingToolCallResolution(args.resolution, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined).resolution
  switch (resolution.case) {
    case "shellResult": {
      const shellResult = resolution.value
      const resultCase = shellResult.result.case
      if (resultCase === undefined) return { result: "Unknown error", isError: true }
      // A recorded shell result may not know where its terminals live; the session's own folder fills that in.
      shellResult.terminalsFolder = shellResult.terminalsFolder ?? args.terminalsFolder!
      return {
        result: renderShellResultToString({
          result: { case: resultCase, value: shellResult.result.value },
          ...(shellResult.sandboxPolicy !== undefined ? { sandboxPolicy: shellResult.sandboxPolicy } : {}),
          ...(shellResult.isBackground !== undefined ? { isBackground: shellResult.isBackground } : {}),
          ...(shellResult.terminalsFolder !== undefined ? { terminalsFolder: shellResult.terminalsFolder } : {}),
        }, { autoBackgroundedForInterruption: true }),
        isError: shellResult.result.case !== "success",
      }
    }
    case "taskResult":
      return {
        result: renderTaskResultToString(resolution.value),
        isError: resolution.value.result.case === "error",
      }
    case undefined: return undefined
    default: {
      const exhaustive: never = resolution
      return exhaustive
    }
  }
}

/** Which tool was interrupted decides how its result reads, and an unknown tool is its own kind. */
function getToolIdentifier(toolName: string, toolMap: Record<string, ToolLike>): string {
  return toolMap[toolName]?.toolIdentifier ?? "other"
}

export function buildInterruptedPendingToolCallMessages(
  stateHandler: InterruptedToolStateHandler,
  tools: ReturnType<typeof getExecutableTools>,
  interruptedPendingToolCallResolutions: RedactedInterruptedResolutions | undefined,
  terminalsFolder: string | undefined,
) {
  const pendingMessages = stateHandler.getRawPendingMessages() ?? []
  if (pendingMessages.length === 0) return []
  const messagesToAppend: ParsedPendingMessage[] = []
  const toolMap: Record<string, ToolLike> = Object.fromEntries(tools.map(tool => [tool.name, tool]))
  const resolutionByToolCallId = new Map(
    interruptedPendingToolCallResolutions?.resolutions.map(resolution => [resolution.toolCallId, resolution]) ?? [],
  )
  for (const pendingMessage of pendingMessages) {
    let parsed: ParsedPendingMessage
    try {
      parsed = JSON.parse(pendingMessage.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)) as ParsedPendingMessage
    } catch {
      // A pending message that cannot be read back is left out rather than guessed at.
      continue
    }
    messagesToAppend.push(parsed)
    if (parsed.role !== "assistant" || !Array.isArray(parsed.content)) continue
    const elapsedMs = getPendingToolCallElapsedMs(parsed)
    const toolResults: Array<Record<string, unknown>> = []
    const rawErrorMessages: string[] = []
    for (const content of parsed.content) {
      if (
        content === null || typeof content !== "object" || Array.isArray(content) ||
        (content as { readonly type?: unknown }).type !== "tool-call"
      ) continue
      const toolCall = content as { readonly toolCallId?: unknown; readonly toolName?: unknown }
      if (typeof toolCall.toolCallId !== "string" || typeof toolCall.toolName !== "string") continue
      const toolIdentifier = getToolIdentifier(toolCall.toolName, toolMap)
      const resolved = formatResolvedInterruptedToolCall({ resolution: resolutionByToolCallId.get(toolCall.toolCallId), terminalsFolder })
      const result = resolved?.result ?? formatInterruptedToolResult({
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        toolIdentifier,
        elapsedMs,
      })
      if (resolved?.isError !== false) rawErrorMessages.push(result)
      toolResults.push({
        type: "tool-result",
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        result,
        // The text part is what a provider that cannot read the structured result will show.
        experimental_content: [{ type: "text", text: result }],
      })
    }
    // Only a message that actually carried tool calls gets an answer, so an assistant turn with nothing
    // pending is passed through as it was.
    if (toolResults.length > 0) {
      messagesToAppend.push({
        role: "tool",
        content: toolResults,
        providerOptions: {
          cursor: {
            highLevelToolCallResult: {
              output: toolResults.map(result => result.result),
              isError: rawErrorMessages.length > 0,
              rawErrorMessages,
            },
          },
        },
      })
    }
  }
  return toRedactedCoreMessages(messagesToAppend, stateHandler.getPrivacyMode())
}
