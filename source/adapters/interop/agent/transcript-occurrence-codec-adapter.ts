/** Decodes persisted transcript bytes through the generated agent message constructors. */

import type {
  DecodedTranscriptStep,
  DecodedTranscriptTurn,
  TranscriptOccurrenceCodec,
} from "../../../host/transcript/mirror/transcript-occurrence-deriver.ts"

interface BinaryMessageType<Message> {
  fromBinary(wireBytes: Uint8Array): Message
}

interface JsonProjectable {
  toJson(): unknown
}

interface ToolReplyShape {
  readonly args?: JsonProjectable & {
    readonly toolName?: string
    readonly name?: string
  }
  readonly result?: JsonProjectable
}

interface TurnShape {
  readonly turn:
    | {
        readonly case: "agentConversationTurn"
        readonly value: {
          readonly userMessage: Uint8Array
          readonly steps: readonly Uint8Array[]
        }
      }
    | { readonly case: "shellConversationTurn"; readonly value: unknown }
    | { readonly case: undefined; readonly value?: undefined }
}

interface UserMessageShape {
  readonly text: string
  readonly textBlobId?: Uint8Array
}

interface StepShape {
  readonly message:
    | {
        readonly case: "assistantMessage" | "thinkingMessage"
        readonly value: { readonly text: string }
      }
    | {
        readonly case: "toolCall"
        readonly value: {
          readonly tool:
            | { readonly case: string; readonly value: ToolReplyShape }
            | { readonly case: undefined; readonly value?: undefined }
        }
      }
    | { readonly case: undefined; readonly value?: undefined }
}

export interface GeneratedTranscriptOccurrenceBindings {
  readonly ConversationTurnStructure: BinaryMessageType<TurnShape>
  readonly UserMessage: BinaryMessageType<UserMessageShape>
  readonly ConversationStep: BinaryMessageType<StepShape>
}

function requireGeneratedType<Message>(
  value: BinaryMessageType<Message> | undefined,
  typeName: string,
): BinaryMessageType<Message> {
  if (typeof value?.fromBinary !== "function") {
    throw new TypeError(`generated ${typeName}.fromBinary is required`)
  }
  return value
}

function slateToolName(caseName: string, value: ToolReplyShape): string {
  if (caseName === "mcpToolCall") return value.args?.toolName ?? value.args?.name ?? "mcp"
  return caseName
    .replace(/ToolCall$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
}

export function createGeneratedTranscriptOccurrenceCodec(
  generatedBindings: GeneratedTranscriptOccurrenceBindings,
): TranscriptOccurrenceCodec {
  const turnType = requireGeneratedType(generatedBindings?.ConversationTurnStructure, "ConversationTurnStructure")
  const userType = requireGeneratedType(generatedBindings?.UserMessage, "UserMessage")
  const stepType = requireGeneratedType(generatedBindings?.ConversationStep, "ConversationStep")

  return {
    decodeTurn(wireBytes): DecodedTranscriptTurn {
      const decoded = turnType.fromBinary(wireBytes)
      if (decoded.turn.case === "agentConversationTurn") {
        return {
          case: "agent",
          userMessage: decoded.turn.value.userMessage,
          steps: decoded.turn.value.steps,
        }
      }
      return decoded.turn.case === "shellConversationTurn"
        ? { case: "shell" }
        : { case: undefined }
    },

    decodeUserMessage(wireBytes) {
      const decoded = userType.fromBinary(wireBytes)
      return {
        text: decoded.text,
        ...(decoded.textBlobId === undefined ? {} : { textBlobId: decoded.textBlobId }),
      }
    },

    decodeStep(wireBytes): DecodedTranscriptStep {
      const decoded = stepType.fromBinary(wireBytes)
      const message = decoded.message
      if (message.case === "assistantMessage" || message.case === "thinkingMessage") {
        return {
          case: message.case === "assistantMessage" ? "assistant" : "thinking",
          text: message.value.text,
        }
      }
      if (message.case !== "toolCall") return { case: undefined }

      const call = message.value.tool
      if (call.case == null) return { case: undefined }
      return {
        case: "tool",
        name: slateToolName(call.case, call.value),
        input: call.value.args?.toJson() ?? {},
        ...(call.value.result == null ? {} : { result: call.value.result.toJson() }),
      }
    },
  }
}
