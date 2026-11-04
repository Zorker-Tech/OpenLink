import type { JsonValue } from "@bufbuild/protobuf";
import {
  ExecClientControlMessage,
  ExecClientMessage,
  ExecClientThrow,
  ExecServerMessage,
} from "../proto/generated/agent/v1/exec_pb.ts";
import { ExecServerAbort, ExecServerControlMessage } from "../proto/generated/agent/v1/agent_service_pb.ts";
import type { LocalExecDecodedMessage } from "../../../host/local-exec/local-exec-provider.ts";
import type { ProductionExecCodec } from "../../../local-exec/production-executor.ts";
import {
  parseLocalExecBackgroundSpawnRequest,
  parseLocalExecListRequest,
  parseLocalExecReadRequest,
  parseLocalExecShellRequest,
  unwrapLegacyLocalExecMessage,
  wrapLegacyLocalExecMessage,
  type LocalExecWireJsonValue,
} from "../../../shared/local-exec-protocol.ts";
import {
  slateBackgroundSpawnRequestToInterop,
  slateBackgroundSpawnResultFromInterop,
  slateListRequestToInterop,
  slateListResultFromInterop,
  slateReadRequestToInterop,
  slateReadResultFromInterop,
  slateShellRequestToInterop,
  slateShellResultFromInterop,
} from "./local-exec-operation-adapter.ts";

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Converts Slate's immutable JSON tree to the mutable array/object shape the generated codec accepts. */
function toProtobufJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** The manager-facing view of one generated server message. */
class CodecServerMessage implements LocalExecDecodedMessage {
  constructor(readonly generated: ExecServerMessage) {}

  get id(): number { return this.generated.id; }
  set id(value: number) { this.generated.id = value; }

  get message(): { readonly case?: string; readonly value?: Record<string, unknown> } {
    const { case: messageCase, value } = this.generated.message;
    if (messageCase === undefined) return {};
    if (!isRecordObject(value)) return { case: messageCase };
    return { case: messageCase, value };
  }
}

/** Binds the generated local-exec transport messages behind Slate's production codec port. */
export function createGeneratedProductionExecCodec(): ProductionExecCodec<ExecServerMessage, ExecClientMessage, ExecClientControlMessage, ExecServerControlMessage> {
  return {
    decodeServerMessage: (json: LocalExecWireJsonValue) => {
      const read = parseLocalExecReadRequest(json);
      const shell = read === undefined ? parseLocalExecShellRequest(json) : undefined;
      const list = read === undefined && shell === undefined ? parseLocalExecListRequest(json) : undefined;
      const background = read === undefined && shell === undefined && list === undefined
        ? parseLocalExecBackgroundSpawnRequest(json)
        : undefined;
      return new CodecServerMessage(
        read !== undefined
          ? slateReadRequestToInterop(read)
          : shell !== undefined
            ? slateShellRequestToInterop(shell)
            : list !== undefined
              ? slateListRequestToInterop(list)
              : background !== undefined
                ? slateBackgroundSpawnRequestToInterop(background)
                : ExecServerMessage.fromJson(
                    toProtobufJson(unwrapLegacyLocalExecMessage(json) ?? json),
                    { ignoreUnknownFields: true },
                  ),
      );
    },
    toManagerMessage: (message) => {
      if (!(message instanceof CodecServerMessage)) throw new TypeError("local-exec decoded message did not originate from the generated production codec");
      return message.generated;
    },
    isClientMessage: (message): message is ExecClientMessage => message instanceof ExecClientMessage,
    clientMessageToJson: (message) => {
      const read = slateReadResultFromInterop(message);
      const shell = read === undefined ? slateShellResultFromInterop(message) : undefined;
      const list = read === undefined && shell === undefined ? slateListResultFromInterop(message) : undefined;
      const background = read === undefined && shell === undefined && list === undefined
        ? slateBackgroundSpawnResultFromInterop(message)
        : undefined;
      return read !== undefined
        ? toProtobufJson(read)
        : shell !== undefined
          ? toProtobufJson(shell)
          : list !== undefined
            ? toProtobufJson(list)
            : background !== undefined
              ? toProtobufJson(background)
              : toProtobufJson(wrapLegacyLocalExecMessage(toProtobufJson(message.toJson())))
    },
    controlMessageToJson: (message) => toProtobufJson(wrapLegacyLocalExecMessage(toProtobufJson(message.toJson()))),
    createAbortControl: (execId) => new ExecServerControlMessage({ message: { case: "abort", value: new ExecServerAbort({ id: execId }) } }),
    createThrowControl: (execId, error) => new ExecClientControlMessage({ message: { case: "throw", value: new ExecClientThrow({ id: execId, error }) } }),
  };
}
