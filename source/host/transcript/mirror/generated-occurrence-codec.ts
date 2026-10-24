/** Reading the generated transcript messages this platform keeps.

 * The conversation turns, the messages in them and the steps between them are decodedMessage from the generated messages, so
 * the deriver sees what the platform wrote rather than a shape of its own. */
import type {
  DecodedTranscriptStep,
  DecodedTranscriptTurn,
  TranscriptOccurrenceCodec,
} from "./transcript-occurrence-deriver.ts";

interface BinaryMessageType<Message> {
  fromBinary(wireBytes: Uint8Array): Message;
}

interface JsonProjectable {
  toJson(): unknown;
}

interface ToolReplyShape {
  readonly args?: JsonProjectable & {
    readonly toolName?: string;
    readonly name?: string;
  };
  readonly result?: JsonProjectable;
}

interface TurnShape {
  readonly turn:
    | {
        readonly case: "agentConversationTurn";
        readonly value: {
          readonly userMessage: Uint8Array;
          readonly steps: readonly Uint8Array[];
        };
      }
    | { readonly case: "shellConversationTurn"; readonly value: unknown }
    | { readonly case: undefined; readonly value?: undefined };
}

interface UserMessageShape {
  readonly text: string;
  readonly textBlobId?: Uint8Array;
}

interface StepShape {
  readonly message:
    | {
        readonly case: "assistantMessage" | "thinkingMessage";
        readonly value: { readonly text: string };
      }
    | {
        readonly case: "toolCall";
        readonly value: {
          readonly tool:
            | {
                readonly case: string;
                readonly value: ToolReplyShape;
              }
            | { readonly case: undefined; readonly value?: undefined };
        };
      }
    | { readonly case: undefined; readonly value?: undefined };
}

/**
 * Narrow generated-source boundary required by the shipped transcript deriver.
 *
 * The constructors are the emitted @bufbuild/protobuf agent.v1 generatedBindings. Their
 * default fromBinary behavior owns malformed-wire errors and unknown-field
 * handling; the toolUnion args/result instances own exact generated toJson behavior.
 */
export interface GeneratedTranscriptOccurrenceBindings {
  readonly ConversationTurnStructure: BinaryMessageType<TurnShape>;
  readonly UserMessage: BinaryMessageType<UserMessageShape>;
  readonly ConversationStep: BinaryMessageType<StepShape>;
}

function requireGeneratedType<Message>(
  value: BinaryMessageType<Message> | undefined,
  typeName: string,
): BinaryMessageType<Message> {
  if (typeof value?.fromBinary !== "function") {
    throw new TypeError(`generated ${typeName}.fromBinary is required`);
  }
  return value;
}

function toolName(
  caseName: string,
  value: ToolReplyShape,
): string {
  if (caseName === "mcpToolCall") {
    return value.args?.toolName ?? value.args?.name ?? "mcp";
  }
  return caseName
    .replace(/ToolCall$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Adapts the exact generated message shapes consumed at
 * host-main.cjs:667421-667490. No protobuf decoder or JSON projection is
 * substituted here: all three fromBinary calls and both toJson calls remain on
 * the mandatory generated-source collaborators.
 */
export function createGeneratedTranscriptOccurrenceCodec(
  generatedBindings: GeneratedTranscriptOccurrenceBindings,
): TranscriptOccurrenceCodec {
  const ConversationTurnStructure = requireGeneratedType(
    generatedBindings?.ConversationTurnStructure,
    "ConversationTurnStructure",
  );
  const UserMessage = requireGeneratedType(generatedBindings?.UserMessage, "UserMessage");
  const ConversationStep = requireGeneratedType(
    generatedBindings?.ConversationStep,
    "ConversationStep",
  );

  return {
    decodeTurn(wireBytes): DecodedTranscriptTurn {
      const decodedMessage = ConversationTurnStructure.fromBinary(wireBytes);
      if (decodedMessage.turn.case === "agentConversationTurn") {
        return {
          case: "agent",
          userMessage: decodedMessage.turn.value.userMessage,
          steps: decodedMessage.turn.value.steps,
        };
      }
      if (decodedMessage.turn.case === "shellConversationTurn") {
        return { case: "shell" };
      }
      return { case: undefined };
    },

    decodeUserMessage(wireBytes) {
      const decodedMessage = UserMessage.fromBinary(wireBytes);
      return {
        text: decodedMessage.text,
        ...(decodedMessage.textBlobId === undefined
          ? {}
          : { textBlobId: decodedMessage.textBlobId }),
      };
    },

    decodeStep(wireBytes): DecodedTranscriptStep {
      const decodedMessage = ConversationStep.fromBinary(wireBytes);
      if (
        decodedMessage.message.case === "assistantMessage"
        || decodedMessage.message.case === "thinkingMessage"
      ) {
        return {
          case: decodedMessage.message.case === "assistantMessage"
            ? "assistant"
            : "thinking",
          text: decodedMessage.message.value.text,
        };
      }
      if (decodedMessage.message.case !== "toolCall") {
        return { case: undefined };
      }
      const toolUnion = decodedMessage.message.value.tool;
      if (toolUnion.case == null) return { case: undefined };
      return {
        case: "tool",
        name: toolName(toolUnion.case, toolUnion.value),
        input: toolUnion.value.args?.toJson() ?? {},
        ...(toolUnion.value.result == null
          ? {}
          : { result: toolUnion.value.result.toJson() }),
      };
    },
  };
}
