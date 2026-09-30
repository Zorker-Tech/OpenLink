/** The codec this build uses for the local-exec bridge.

 * What a caller serializes is decoded from generated messages, with unknown fields ignored, so a daemon that is ahead of
 * this build still reaches it: a client frame becomes the message the tool layer takes, and a control frame becomes the
 * throw or the stream close the bridge acts on. */
import { RemoteResourceAccessor } from "../../packages/agent-exec/resource-provider.ts";
import { ExecClientControlMessage, ExecClientMessage } from "../../packages/proto/generated/agent/v1/exec_pb.ts";
import type { JsonValue } from "@bufbuild/protobuf";
import type { GatewayLocalExecCodec, GatewayLocalExecManager } from "./gateway-local-exec-slate-box.ts";

/**
 * Concrete artifact-backed codec used by the production local-exec extension.
 *
 * Evidence: the shipped manager decodes client and control frames through the
 * generated JSON codecs with unknown fields ignored, and ensureReady exposes a
 * package-owned RemoteResourceAccessor over that manager.
 *
 * - src/app/dist/host/host-main.cjs:617932-617952
 * - src/app/dist/host/host-main.cjs:617977-617991
 */
export const productionLocalExecCodec: GatewayLocalExecCodec<
  ExecClientMessage,
  RemoteResourceAccessor<GatewayLocalExecManager<ExecClientMessage>>
> = Object.freeze({
  decodeClient(json: JsonValue): ExecClientMessage {
    return ExecClientMessage.fromJson(json, { ignoreUnknownFields: true });
  },
  decodeControl(json: JsonValue) {
    const control = ExecClientControlMessage.fromJson(json, { ignoreUnknownFields: true }).message;
    switch (control.case) {
      case "throw": {
        const thrown = control.value as { readonly error: string; readonly stackTrace?: string };
        return {
          case: "throw" as const,
          error: thrown.error,
          ...(thrown.stackTrace === undefined ? {} : { stackTrace: thrown.stackTrace }),
        };
      }
      case "streamClose":
        return { case: "streamClose" as const };
      default:
        return { case: undefined };
    }
  },
  createRemoteAccessor(manager: GatewayLocalExecManager<ExecClientMessage>): RemoteResourceAccessor<GatewayLocalExecManager<ExecClientMessage>> {
    return new RemoteResourceAccessor(manager);
  },
});
