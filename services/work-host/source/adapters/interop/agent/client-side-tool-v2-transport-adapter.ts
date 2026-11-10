/**
 * Carrying a client-side tool call over the wire.
 *
 * The payload is the generated representation rather than a hand-written shape, so the two ends cannot drift apart, and
 * what comes back is checked before it is handed to a caller.
 */
import {
  ClientSideToolV2Call,
  ClientSideToolV2Result,
} from "../proto/generated/aiserver/v1/tools_pb.ts";

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

type AnyMessage = ClientSideToolV2Call | ClientSideToolV2Result;
type Decoder = (data: Uint8Array) => AnyMessage;
type WireShape = { readonly type: EncodedClientSideToolV2Message["messageType"]; readonly decode: Decoder };

const WIRE_SHAPES = new Map<ClientSideToolV2MessageKind, WireShape>([
  ["call", { type: "aiserver.v1.ClientSideToolV2Call", decode: data => ClientSideToolV2Call.fromBinary(data) }],
  ["result", { type: "aiserver.v1.ClientSideToolV2Result", decode: data => ClientSideToolV2Result.fromBinary(data) }],
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function base64Bytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return null;
  const validAlphabet = /^[A-Za-z0-9+/]+={0,2}$/.test(value);
  if (!validAlphabet) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
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
  const envelope = asRecord(value);
  const shape = WIRE_SHAPES.get(kind);
  if (envelope === null || shape === undefined) return null;
  if (envelope.encoding !== "protobuf-base64" || envelope.messageType !== shape.type) return null;
  const data = base64Bytes(envelope.bytes);
  if (data === null) return null;
  try {
    const message = shape.decode(data);
    return message.toolCallId.length === 0 ? null : message;
  } catch {
    return null;
  }
}

export function parseClientSideToolV2TransportEvent(value: unknown): ClientSideToolV2TransportEvent | null {
  const event = asRecord(value);
  if (event === null || event.version !== CLIENT_SIDE_TOOL_V2_WIRE_VERSION) return null;
  const accountSlot = stringOrNull(event.accountSlot);
  const agentId = stringOrNull(event.agentId);
  const epoch = stringOrNull(event.epoch);
  const sequence = event.sequence;
  const hasIdentity = accountSlot !== null && agentId !== null && epoch !== null;
  const hasSequence = Number.isSafeInteger(sequence) && (sequence as number) > 0;
  if (!hasIdentity || !hasSequence) return null;
  const base = { version: CLIENT_SIDE_TOOL_V2_WIRE_VERSION, accountSlot, agentId, epoch, sequence: sequence as number } as const;
  if (event.kind === "reset") return { ...base, kind: "reset" };
  const kind = event.kind;
  if (kind !== "call" && kind !== "result") return null;
  const message = event.message;
  if (decodeClientSideToolV2Message(kind, message) === null) return null;
  return { ...base, kind, message: message as EncodedClientSideToolV2Message };
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
