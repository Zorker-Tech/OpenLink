import {
  KIND_CLOSE,
  KIND_DATA,
  KIND_OPEN,
  type EgressFrame,
} from "./exit-client-contracts.ts";

export function decodeFrame(bytes: Buffer): EgressFrame | null {
  if (bytes.length < 5) return null;
  const kind = bytes[0];
  const streamId = bytes.readUInt32BE(1);
  if (kind === KIND_OPEN) {
    if (bytes.length < 7) return null;
    return { kind, streamId, port: bytes.readUInt16BE(5), host: bytes.toString("utf8", 7) };
  }
  if (kind === KIND_DATA) return { kind, streamId, payload: bytes.subarray(5) };
  return kind === KIND_CLOSE ? { kind, streamId } : null;
}

export function encodeData(streamId: number, payload: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame[0] = KIND_DATA;
  frame.writeUInt32BE(streamId >>> 0, 1);
  payload.copy(frame, 5);
  return frame;
}

export function encodeClose(streamId: number): Buffer {
  const frame = Buffer.allocUnsafe(5);
  frame[0] = KIND_CLOSE;
  frame.writeUInt32BE(streamId >>> 0, 1);
  return frame;
}

export function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Uint8Array[]);
  return Buffer.from(data as ArrayBuffer);
}
