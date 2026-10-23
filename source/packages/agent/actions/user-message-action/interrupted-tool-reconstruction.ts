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

function elapsedForPendingCall(pendingMessage: {
  readonly providerOptions?: {
    readonly cursor?: { readonly pendingToolCallStartedAtMs?: unknown } | undefined
  } | undefined
}): number | undefined {
  const startedAt = pendingMessage.providerOptions?.cursor?.pendingToolCallStartedAtMs
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return undefined
  return Math.max(0, Date.now() - startedAt)
}

function formatElapsedText(elapsedMs: number | undefined): string {
  return elapsedMs !== undefined ? ` after ${elapsedMs}ms` : ""
}

function interruptedAwaitText(elapsedMs: number | undefined): string {
  return `Error: Await was interrupted by the user${formatElapsedText(elapsedMs)}.`
}

/** The output a shell command had produced before it was stopped is worth keeping, so it is quoted. */
function interruptedShellText(args: { readonly toolCallId: string; readonly elapsedMs: number | undefined }): string {
  const partialOutput = getInterruptedShellOutputSnapshot(args.toolCallId)
  clearInterruptedShellOutputSnapshot(args.toolCallId)
  const elapsedText = formatElapsedText(args.elapsedMs)
  if (partialOutput === undefined || partialOutput.length === 0) {
    return `Error: Shell command was interrupted by the user${elapsedText} before it completed.`
  }
  const partialOutputSection = formatShellPartialOutputSection(partialOutput, {
    heading: "Output collected before interruption",
    truncatedSuffix: " (truncated)",
  })
  return `Error: Shell command was interrupted by the user${elapsedText} before it completed.\n\n${partialOutputSection}`
}

function interruptedToolText(args: {
  readonly toolIdentifier: string
  readonly toolCallId: string
  readonly toolName: string
  readonly elapsedMs: number | undefined
}): string {
  switch (args.toolIdentifier) {
    case "AWAIT": return interruptedAwaitText(args.elapsedMs)
    case "SHELL": return interruptedShellText({ toolCallId: args.toolCallId, elapsedMs: args.elapsedMs })
    default: return `Error: ${args.toolName} was interrupted by the user${formatElapsedText(args.elapsedMs)} before it completed.`
  }
}

/** The host's own record of what the interrupted call produced, rendered as the result the model reads. */
function resolvedToolText(args: {
  readonly resolution: RedactedInterruptedResolution | undefined
  readonly terminalsFolder: string | undefined
}): { readonly result: string; readonly isError: boolean } | undefined {
  if (args.resolution === undefined) return undefined
  const hostResolution = fromRedactedInterruptedPendingToolCallResolution(args.resolution, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined).resolution
  switch (hostResolution.case) {
    case "shellResult": {
      const recordedShell = hostResolution.value
      const outcomeCase = recordedShell.result.case
      if (outcomeCase === undefined) return { result: "Unknown error", isError: true }
      // A recorded shell result may not know where its terminals live; the session's own folder fills that in.
      recordedShell.terminalsFolder = recordedShell.terminalsFolder ?? args.terminalsFolder!
      return {
        result: renderShellResultToString({
          result: { case: outcomeCase, value: recordedShell.result.value },
          ...(recordedShell.sandboxPolicy !== undefined ? { sandboxPolicy: recordedShell.sandboxPolicy } : {}),
          ...(recordedShell.isBackground !== undefined ? { isBackground: recordedShell.isBackground } : {}),
          ...(recordedShell.terminalsFolder !== undefined ? { terminalsFolder: recordedShell.terminalsFolder } : {}),
        }, { autoBackgroundedForInterruption: true }),
        isError: recordedShell.result.case !== "success",
      }
    }
    case "taskResult":
      return {
        result: renderTaskResultToString(hostResolution.value),
        isError: hostResolution.value.result.case === "error",
      }
    case undefined: return undefined
    default: {
      const exhaustive: never = hostResolution
      return exhaustive
    }
  }
}

/** Which tool was interrupted decides how its result reads, and an unknown tool is its own kind. */
function toolKindFor(toolName: string, toolsByName: Record<string, ToolLike>): string {
  return toolsByName[toolName]?.toolIdentifier ?? "other"
}

export function buildInterruptedPendingToolCallMessages(
  stateHandler: InterruptedToolStateHandler,
  executableTools: ReturnType<typeof getExecutableTools>,
  hostResolutions: RedactedInterruptedResolutions | undefined,
  terminalsFolder: string | undefined,
) {
  const rawPending = stateHandler.getRawPendingMessages() ?? []
  if (rawPending.length === 0) return []
  const appendedMessages: ParsedPendingMessage[] = []
  const toolsByName: Record<string, ToolLike> = Object.fromEntries(executableTools.map(tool => [tool.name, tool]))
  const resolutionsByCall = new Map(
    hostResolutions?.resolutions.map(hostResolution => [hostResolution.toolCallId, hostResolution]) ?? [],
  )
  for (const pendingMessage of rawPending) {
    let parsedPending: ParsedPendingMessage
    try {
      parsedPending = JSON.parse(pendingMessage.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)) as ParsedPendingMessage
    } catch {
      // A pending message that cannot be read back is left out rather than guessed at.
      continue
    }
    appendedMessages.push(parsedPending)
    if (parsedPending.role !== "assistant" || !Array.isArray(parsedPending.content)) continue
    const elapsedMs = elapsedForPendingCall(parsedPending)
    const resultParts: Array<Record<string, unknown>> = []
    const rawErrorMessages: string[] = []
    for (const contentPart of parsedPending.content) {
      if (
        contentPart === null || typeof contentPart !== "object" || Array.isArray(contentPart) ||
        (contentPart as { readonly type?: unknown }).type !== "tool-call"
      ) continue
      const pendingCall = contentPart as { readonly toolCallId?: unknown; readonly toolName?: unknown }
      if (typeof pendingCall.toolCallId !== "string" || typeof pendingCall.toolName !== "string") continue
      const toolIdentifier = toolKindFor(pendingCall.toolName, toolsByName)
      const hostText = resolvedToolText({ resolution: resolutionsByCall.get(pendingCall.toolCallId), terminalsFolder })
      const result = hostText?.result ?? interruptedToolText({
        toolCallId: pendingCall.toolCallId,
        toolName: pendingCall.toolName,
        toolIdentifier,
        elapsedMs,
      })
      if (hostText?.isError !== false) rawErrorMessages.push(result)
      resultParts.push({
        type: "tool-result",
        toolCallId: pendingCall.toolCallId,
        toolName: pendingCall.toolName,
        result,
        // The text part is what a provider that cannot read the structured result will show.
        experimental_content: [{ type: "text", text: result }],
      })
    }
    // Only a message that actually carried tool calls gets an answer, so an assistant turn with nothing
    // pending is passed through as it was.
    if (resultParts.length > 0) {
      appendedMessages.push({
        role: "tool",
        content: resultParts,
        providerOptions: {
          cursor: {
            highLevelToolCallResult: {
              output: resultParts.map(result => result.result),
              isError: rawErrorMessages.length > 0,
              rawErrorMessages,
            },
          },
        },
      })
    }
  }
  return toRedactedCoreMessages(appendedMessages, stateHandler.getPrivacyMode())
}
