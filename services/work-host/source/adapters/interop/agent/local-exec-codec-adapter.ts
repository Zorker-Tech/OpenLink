import type { JsonValue } from "@bufbuild/protobuf";
import { RemoteResourceAccessor } from "../../../packages/agent-exec/resource-provider.ts";
import {
  ExecClientControlMessage,
  ExecClientMessage,
} from "../proto/generated/agent/v1/exec_pb.ts";
import type {
  GatewayExecControl,
  GatewayExecServerMessage,
  GatewayLocalExecCodec,
  GatewayLocalExecManager,
} from "../../../host/local-exec/gateway-local-exec-slate-box.ts";
import {
  slateBackgroundSpawnRequestFromInterop,
  slateBackgroundSpawnResultToInterop,
  slateListRequestFromInterop,
  slateListResultToInterop,
  slateReadRequestFromInterop,
  slateReadResultToInterop,
  slateShellRequestFromInterop,
  slateShellResultToInterop,
} from "./local-exec-operation-adapter.ts";
import type { LocalExecWireJsonValue } from "../../../shared/local-exec-protocol.ts";
import {
  SLATE_LOCAL_EXEC_LEGACY_SCHEMA,
  SLATE_LOCAL_EXEC_OPERATION_SCHEMA,
  unwrapLegacyLocalExecMessage,
  wrapLegacyLocalExecMessage,
} from "../../../shared/local-exec-protocol.ts";

type ProductionAccessor = RemoteResourceAccessor<GatewayLocalExecManager<ExecClientMessage>>;

function toWireJson(value: unknown): LocalExecWireJsonValue {
  return JSON.parse(JSON.stringify(value)) as LocalExecWireJsonValue;
}

function toGeneratedJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function decodeClientFrame(json: unknown): ExecClientMessage {
  return ExecClientMessage.fromJson(toGeneratedJson(json), { ignoreUnknownFields: true });
}

function decodeControlFrame(json: unknown): GatewayExecControl {
  const control = ExecClientControlMessage.fromJson(toGeneratedJson(json), { ignoreUnknownFields: true }).message;
  switch (control.case) {
    case "throw": {
      const failure = control.value as { readonly error: string; readonly stackTrace?: string };
      return {
        case: "throw",
        error: failure.error,
        ...(failure.stackTrace === undefined ? {} : { stackTrace: failure.stackTrace }),
      };
    }
    case "streamClose":
      return { case: "streamClose" };
    default:
      return { case: undefined };
  }
}

function accessorForManager(manager: GatewayLocalExecManager<ExecClientMessage>): ProductionAccessor {
  return new RemoteResourceAccessor(manager);
}

/** Bind the generated daemon frames to the host's local-exec codec and resource-accessor ports. */
export const productionLocalExecCodec: GatewayLocalExecCodec<ExecClientMessage, ProductionAccessor> = Object.freeze({
  encodeRequest: (message: GatewayExecServerMessage): LocalExecWireJsonValue => {
    const read = slateReadRequestFromInterop(message as never);
    const shell = read === undefined ? slateShellRequestFromInterop(message as never) : undefined;
    const list = read === undefined && shell === undefined ? slateListRequestFromInterop(message as never) : undefined;
    const background = read === undefined && shell === undefined && list === undefined
      ? slateBackgroundSpawnRequestFromInterop(message as never)
      : undefined;
    return read !== undefined
      ? toWireJson(read)
      : shell !== undefined
        ? toWireJson(shell)
        : list !== undefined
          ? toWireJson(list)
          : background !== undefined
            ? toWireJson(background)
            : toWireJson(wrapLegacyLocalExecMessage(message.toJson() as LocalExecWireJsonValue));
  },
  decodeClient: (json: unknown) => {
    const legacy = unwrapLegacyLocalExecMessage(json);
    return slateReadResultToInterop(json)
      ?? slateShellResultToInterop(json)
      ?? slateListResultToInterop(json)
      ?? slateBackgroundSpawnResultToInterop(json)
      ?? decodeClientFrame(legacy ?? json);
  },
  decodeControl: (json: unknown) => decodeControlFrame(unwrapLegacyLocalExecMessage(json) ?? json),
  createRemoteAccessor: accessorForManager,
});
