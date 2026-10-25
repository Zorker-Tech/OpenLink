/**
 * Carrying a client-side tool call over the wire.
 *
 * The payload is the generated representation rather than a hand-written shape, so the two ends cannot drift apart, and
 * what comes back is checked before it is handed to a caller.
 */
import {
  ClientSideToolV2Call,
  ClientSideToolV2Result,
} from "../../packages/proto/generated/aiserver/v1/tools_pb.ts";

// The payload is the generated protobuf wire representation, not a hand-shaped
// JSON substitute. Immutable renderer evidence:
// src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=3097937
// src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=3102316

export const CLIENT_SIDE_TOOL_V2_FAMILY = "client-side-tool-v2";
export const CLIENT_SIDE_TOOL_V2_WIRE_VERSION = 1;
export const CLIENT_SIDE_TOOL_V2_ACCOUNT_SLOT = "host";

export type ClientSideToolV2MessageKind = "call" | "result";

export interface EncodedClientSideToolV2Message {
  readonly encoding: "protobuf-base64";
  readonly messageType:
    | "aiserver.v1.ClientSideToolV2Call"
    | "aiserver.v1.ClientSideToolV2Result";
  readonly bytes: string;
}

export interface ClientSideToolV2TransportUpdate {
  readonly version: typeof CLIENT_SIDE_TOOL_V2_WIRE_VERSION;
  readonly kind: ClientSideToolV2MessageKind;
  readonly accountSlot: string;
  readonly agentId: string;
  readonly epoch: string;
  readonly sequence: number;
  readonly message: EncodedClientSideToolV2Message;
}

export interface ClientSideToolV2TransportReset {
  readonly version: typeof CLIENT_SIDE_TOOL_V2_WIRE_VERSION;
  readonly kind: "reset";
  readonly accountSlot: string;
  readonly agentId: string;
  readonly epoch: string;
  readonly sequence: number;
}

export type ClientSideToolV2TransportEvent =
  | ClientSideToolV2TransportUpdate
  | ClientSideToolV2TransportReset;

function recordFields(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function canonicalBase64(value: string): Uint8Array | null {
  if (value.length === 0) return null;
  if (value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const decodedBytes = Buffer.from(value, "base64");
  if (decodedBytes.toString("base64") === value) return decodedBytes;
  return null;
}

export function encodeClientSideToolV2Message(
  kind: "call",
  value: ClientSideToolV2Call,
): EncodedClientSideToolV2Message;
export function encodeClientSideToolV2Message(
  kind: "result",
  value: ClientSideToolV2Result,
): EncodedClientSideToolV2Message;
export function encodeClientSideToolV2Message(
  kind: ClientSideToolV2MessageKind,
  value: ClientSideToolV2Call | ClientSideToolV2Result,
): EncodedClientSideToolV2Message {
  return {
    encoding: "protobuf-base64",
    messageType: kind === "call"
      ? "aiserver.v1.ClientSideToolV2Call"
      : "aiserver.v1.ClientSideToolV2Result",
    bytes: Buffer.from(value.toBinary()).toString("base64"),
  };
}

export function decodeClientSideToolV2Message(
  kind: ClientSideToolV2MessageKind,
  value: unknown,
): ClientSideToolV2Call | ClientSideToolV2Result | null {
  const fields = recordFields(value);
  if (fields === undefined || fields.encoding !== "protobuf-base64" || typeof fields.bytes !== "string") return null;
  const expectedType = kind === "call"
    ? "aiserver.v1.ClientSideToolV2Call"
    : "aiserver.v1.ClientSideToolV2Result";
  if (fields.messageType !== expectedType) return null;
  const bytes = canonicalBase64(fields.bytes as string);
  if (bytes === null) return null;
  try {
    const decoded = kind === "call"
      ? ClientSideToolV2Call.fromBinary(bytes)
      : ClientSideToolV2Result.fromBinary(bytes);
    if (decoded.toolCallId.length === 0) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function parseClientSideToolV2TransportEvent(value: unknown): ClientSideToolV2TransportEvent | null {
  const fields = recordFields(value);
  if (fields === undefined || fields.version !== CLIENT_SIDE_TOOL_V2_WIRE_VERSION) return null;
  if (!nonBlankString(fields.accountSlot) || !nonBlankString(fields.agentId) || !nonBlankString(fields.epoch)) return null;
  if (!Number.isSafeInteger(fields.sequence) || (fields.sequence as number) < 1) return null;
  const base = {
    version: CLIENT_SIDE_TOOL_V2_WIRE_VERSION,
    accountSlot: fields.accountSlot as string,
    agentId: fields.agentId as string,
    epoch: fields.epoch as string,
    sequence: fields.sequence as number,
  } as const;
  const isReset = fields.kind === "reset";
  if (isReset) return { ...base, kind: "reset" };
  if (fields.kind !== "call" && fields.kind !== "result") return null;
  if (decodeClientSideToolV2Message(fields.kind, fields.message) === null) return null;
  return { ...base, kind: fields.kind, message: fields.message as unknown as EncodedClientSideToolV2Message };
}

export function materializeClientSideToolV2RendererEvent(value: unknown): (Omit<ClientSideToolV2TransportUpdate, "message"> & {
  readonly message: Omit<EncodedClientSideToolV2Message, "bytes" | "encoding"> & {
    readonly encoding: "protobuf";
    readonly bytes: Uint8Array;
  };
}) | ClientSideToolV2TransportReset | null {
  const event = parseClientSideToolV2TransportEvent(value);
  if (event == null || event.kind === "reset") return event;
  return {
    ...event,
    message: {
      encoding: "protobuf",
      messageType: event.message.messageType,
      bytes: Buffer.from(event.message.bytes, "base64"),
    },
  };
}
