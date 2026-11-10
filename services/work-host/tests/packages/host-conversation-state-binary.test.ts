import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TranscriptMirrorProtobufDecodeError,
  decodeSummaryArchiveMessageIds,
  decodeTranscriptMirrorConversationState,
} from "../../source/host/transcript/mirror/conversation-state-binary.ts";
import { ConversationStateStructure } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts";
import { encodeInteropAgentConversationCheckpoint } from "../../source/adapters/interop/agent/agent-conversation-protobuf-adapter.ts";

/** A varint as the record writes it. */
function varint(value: number): Buffer {
  const parts: number[] = [];
  let rest = value;
  do {
    const group = rest % 128;
    rest = Math.floor(rest / 128);
    parts.push(rest > 0 ? group | 0x80 : group);
  } while (rest > 0);
  return Buffer.from(parts);
}

/** One field, written the way the record writes it. */
const field = {
  varint: (number: number, value: number) => Buffer.concat([varint(number * 8), varint(value)]),
  bytes: (number: number, value: Buffer) => Buffer.concat([varint(number * 8 + 2), varint(value.length), value]),
  fixed64: (number: number) => Buffer.concat([varint(number * 8 + 1), Buffer.alloc(8, 7)]),
  fixed32: (number: number) => Buffer.concat([varint(number * 8 + 5), Buffer.alloc(4, 9)]),
  group: (number: number, inner: Buffer) => Buffer.concat([varint(number * 8 + 3), inner, varint(number * 8 + 4)]),
};

const record = (...fields: Buffer[]): Buffer => Buffer.concat(fields);

/** The bytes a decoder refused, and what it said about them. */
function refusal(bytes: Buffer): TranscriptMirrorProtobufDecodeError {
  try {
    decodeTranscriptMirrorConversationState(bytes);
  } catch (error) {
    assert.equal(error instanceof TranscriptMirrorProtobufDecodeError, true, String(error));
    return error as TranscriptMirrorProtobufDecodeError;
  }
  throw new Error("the record was accepted");
}

describe("reading a stored conversation state", () => {
  it("returns the three reference lists it holds, in the order the record keeps them", () => {
    const state = decodeTranscriptMirrorConversationState(
      record(field.bytes(1, Buffer.from("prompt-a")), field.bytes(8, Buffer.from("turn-a")), field.bytes(1, Buffer.from("prompt-b")), field.bytes(13, Buffer.from("archive-a"))),
    );
    assert.deepEqual(state.rootPromptMessagesJson.map(String), ["prompt-a", "prompt-b"]);
    assert.deepEqual(state.turns.map(String), ["turn-a"]);
    assert.deepEqual(state.summaryArchives.map(String), ["archive-a"]);
  });

  it("ignores a field it was not asked for, whatever way that field is written", () => {
    const state = decodeTranscriptMirrorConversationState(
      record(
        field.bytes(2, Buffer.from("not ours")),
        field.varint(3, 300),
        field.fixed64(4),
        field.fixed32(5),
        field.group(6, field.varint(1, 1)),
        field.bytes(8, Buffer.from("turn")),
        field.bytes(99, Buffer.from("unknown")),
      ),
    );
    assert.deepEqual(state.rootPromptMessagesJson, []);
    assert.deepEqual(state.turns.map(String), ["turn"]);
    assert.deepEqual(state.summaryArchives, []);
  });

  it("does not mistake a wanted field number for a wanted wire type", () => {
    // Field 1 written as a varint and as a fixed 64-bit value: neither is the length-prefixed list.
    const state = decodeTranscriptMirrorConversationState(record(field.varint(1, 5), field.fixed64(1), field.bytes(1, Buffer.from("real"))));
    assert.deepEqual(state.rootPromptMessagesJson.map(String), ["real"]);
  });

  it("reads an empty record as a state with nothing in it", () => {
    assert.deepEqual(decodeTranscriptMirrorConversationState(Buffer.alloc(0)), { rootPromptMessagesJson: [], turns: [], summaryArchives: [] });
  });

  it("reads transcript references from a Slate checkpoint root", () => {
    const bytes = encodeInteropAgentConversationCheckpoint(new ConversationStateStructure({
      rootPromptMessagesJson: [new Uint8Array([1, 2])],
      turns: [new Uint8Array([3, 4])],
      summaryArchives: [new Uint8Array([5, 6])],
    }));
    const state = decodeTranscriptMirrorConversationState(bytes);
    assert.deepEqual(state.rootPromptMessagesJson, [new Uint8Array([1, 2])]);
    assert.deepEqual(state.turns, [new Uint8Array([3, 4])]);
    assert.deepEqual(state.summaryArchives, [new Uint8Array([5, 6])]);
  });

  it("keeps an empty reference as a reference", () => {
    const state = decodeTranscriptMirrorConversationState(record(field.bytes(8, Buffer.alloc(0))));
    assert.deepEqual(state.turns.map((turn) => turn.length), [0]);
  });

  it("reads a varint that takes several bytes", () => {
    const state = decodeTranscriptMirrorConversationState(record(field.bytes(13, Buffer.alloc(300, 1))));
    assert.deepEqual(state.summaryArchives.map((archive) => archive.length), [300]);
  });
});

describe("reading the ids an archive summarized", () => {
  it("returns field one's run of ids and nothing else", () => {
    const ids = decodeSummaryArchiveMessageIds(record(field.bytes(1, Buffer.from("m1")), field.bytes(2, Buffer.from("ignored")), field.bytes(1, Buffer.from("m2"))));
    assert.deepEqual(ids.map(String), ["m1", "m2"]);
  });

  it("keeps the ids in the order the archive writes them", () => {
    const ids = decodeSummaryArchiveMessageIds(record(field.bytes(1, Buffer.from("first")), field.bytes(1, Buffer.from("second")), field.bytes(1, Buffer.from("third"))));
    assert.deepEqual(ids.map(String), ["first", "second", "third"]);
  });

  it("returns nothing for an archive that summarized nothing", () => {
    assert.deepEqual(decodeSummaryArchiveMessageIds(Buffer.alloc(0)), []);
  });
});

describe("a record that does not parse", () => {
  it("is refused when a varint runs out of bytes", () => {
    const error = refusal(Buffer.from([0x08, 0x80]));
    assert.match(error.message, /varint/);
  });

  it("is refused when a varint is longer than ten bytes", () => {
    refusal(Buffer.concat([Buffer.from([0x08]), Buffer.alloc(10, 0x80)]));
    // Ten continuation bytes and then a terminator: eleven bytes for one number.
    refusal(Buffer.concat([Buffer.from([0x08]), Buffer.alloc(10, 0x80), Buffer.from([0x00])]));
  });

  it("is refused when a varint claims more than a safe integer", () => {
    // Nine groups of 127 followed by a group that pushes the value past 2^53.
    const bytes = Buffer.concat([Buffer.from([0x08]), Buffer.alloc(9, 0xff), Buffer.from([0x7f])]);
    refusal(bytes);
  });

  it("is refused when a length-prefixed field is shorter than its length says", () => {
    const error = refusal(Buffer.concat([Buffer.from([0x0a, 0x08]), Buffer.from("short")]));
    assert.match(error.message, /length/);
  });

  it("steps over a 32-bit field by four bytes and a 64-bit one by eight", () => {
    const state = decodeTranscriptMirrorConversationState(record(field.fixed32(5), field.fixed64(6), field.bytes(8, Buffer.from("turn"))));
    assert.deepEqual(state.turns.map(String), ["turn"]);
  });

  it("is refused when a field it must skip runs past the record", () => {
    refusal(Buffer.concat([Buffer.from([0x09]), Buffer.alloc(2, 1)]));
    refusal(Buffer.concat([Buffer.from([0x0d]), Buffer.alloc(2, 1)]));
    refusal(Buffer.concat([Buffer.from([0x12, 0x10]), Buffer.from("short")]));
  });

  it("is refused when a field is numbered zero", () => {
    const error = refusal(Buffer.from([0x00, 0x00]));
    assert.match(error.message, /zero/);
  });

  it("is refused when a field is written with a wire type that does not exist", () => {
    refusal(Buffer.from([0x0e]));
    refusal(Buffer.from([0x0f]));
  });

  it("is refused when a group never closes or closes under another field's number", () => {
    // A group whose inner field parses, and then the record ends without the group closing.
    refusal(Buffer.concat([Buffer.from([0x1b]), field.varint(1, 0)]));
    refusal(Buffer.from([0x1b]));
    refusal(Buffer.concat([Buffer.from([0x1b]), varint(8 * 2 + 4)]));
  });

  it("is refused when a group ends where none started", () => {
    refusal(Buffer.from([0x0c]));
  });

  it("is reported under its own name, so a caller can tell it apart", () => {
    const error = refusal(Buffer.from([0x00]));
    assert.equal(error.name, "TranscriptMirrorProtobufDecodeError");
    assert.equal(error instanceof Error, true);
  });
});
