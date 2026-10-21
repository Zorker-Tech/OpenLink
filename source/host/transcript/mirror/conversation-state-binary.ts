/**
 * A conversation's state, as it is stored.
 *
 * The state is written in the binary the platform defined, with the references it holds resolved into the store's own
 * identifiers, and what is read back is checked before it is used — a record that does not parse is reported rather
 * than half-applied.
 */

/**
 * The three reference lists the transcript mirror reads out of a stored conversation state. The generated structure
 * has many more fields; the ones that are not listed here are skipped as protobuf says to skip them, because writing
 * the transcript's JSONL never looks at them.
 */
export interface TranscriptMirrorConversationState {
  readonly rootPromptMessagesJson: readonly Uint8Array[];
  readonly turns: readonly Uint8Array[];
  readonly summaryArchives: readonly Uint8Array[];
}

export class TranscriptMirrorProtobufDecodeError extends Error {
  override name = "TranscriptMirrorProtobufDecodeError";
}

/** The wire types of the protobuf encoding these records use. */
const VARINT = 0;
const FIXED_64 = 1;
const LENGTH_DELIMITED = 2;
const START_GROUP = 3;
const END_GROUP = 4;
const FIXED_32 = 5;

/** Field numbers, read from agent.v1's ConversationStateStructure and ConversationSummaryArchive. */
const STATE = { rootPromptMessagesJson: 1, turns: 8, summaryArchives: 13 } as const;
const SUMMARY_ARCHIVE = { summarizedMessages: 1 } as const;

/** A varint is at most ten bytes: seven bits each, and the tenth only carries the sign. */
const VARINT_BYTES = 10;

/**
 * Reads one record, byte by byte, refusing anything that ends early or claims more than it can carry.
 *
 * Every read either lands the cursor past what it consumed or throws: a caller never has to check whether a partial
 * value came back.
 */
class WireReader {
  private cursor = 0;

  constructor(private readonly bytes: Uint8Array) {}

  /** Nothing left to read: the record is complete. */
  get done(): boolean {
    return this.cursor >= this.bytes.length;
  }

  /** A base-128 varint, one seven-bit group per byte, most significant last. */
  varint(): number {
    let value = 0;
    let scale = 1;
    for (let taken = 0; taken < VARINT_BYTES; taken += 1) {
      const byte = this.bytes[this.cursor];
      if (byte === undefined) throw new TranscriptMirrorProtobufDecodeError("the varint ends before its last byte");
      this.cursor += 1;
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(value)) throw new TranscriptMirrorProtobufDecodeError("the varint is larger than a safe integer");
        return value;
      }
      scale *= 128;
    }
    throw new TranscriptMirrorProtobufDecodeError("the varint runs past its tenth byte");
  }

  /** A length-prefixed run of bytes, as its own copy. */
  lengthDelimited(): Uint8Array {
    const length = this.varint();
    const to = this.cursor + length;
    if (!Number.isSafeInteger(to) || to > this.bytes.length) throw new TranscriptMirrorProtobufDecodeError("a length-prefixed field is shorter than its length");
    const value = this.bytes.slice(this.cursor, to);
    this.cursor = to;
    return value;
  }

  /** Moves the cursor on, refusing to move it past the record. */
  private advance(count: number): void {
    this.cursor += count;
    if (this.cursor > this.bytes.length) throw new TranscriptMirrorProtobufDecodeError("a field is shorter than it claims");
  }

  /** Steps over a field nobody asked for. A group is stepped over as its nested fields, until it says it ends. */
  skip(wireType: number, fieldNumber: number): void {
    switch (wireType) {
      case VARINT:
        this.varint();
        return;
      case FIXED_64:
        this.advance(8);
        return;
      case FIXED_32:
        this.advance(4);
        return;
      case LENGTH_DELIMITED:
        this.advance(this.varint());
        return;
      case START_GROUP: {
        while (!this.done) {
          const tag = this.varint();
          const nested = Math.floor(tag / 8);
          const nestedWireType = tag & 7;
          if (nestedWireType === END_GROUP) {
            if (nested !== fieldNumber) throw new TranscriptMirrorProtobufDecodeError("a group ends under another field's number");
            return;
          }
          this.skip(nestedWireType, nested);
        }
        throw new TranscriptMirrorProtobufDecodeError("a group is never closed");
      }
      case END_GROUP:
        throw new TranscriptMirrorProtobufDecodeError("a group ends where none started");
      default:
        throw new TranscriptMirrorProtobufDecodeError(`no field is written as wire type ${wireType}`);
    }
  }
}

/**
 * Collects every length-prefixed field whose number the caller wants, in the order the record holds them.
 *
 * A record that is refused raises before anything is returned, so a caller never sees half of one list and none of
 * another.
 */
function collectLengthDelimited(bytes: Uint8Array, wanted: ReadonlySet<number>): ReadonlyMap<number, readonly Uint8Array[]> {
  const reader = new WireReader(bytes);
  const collected = new Map<number, Uint8Array[]>();
  for (const fieldNumber of wanted) collected.set(fieldNumber, []);

  while (!reader.done) {
    const tag = reader.varint();
    const fieldNumber = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (fieldNumber === 0) throw new TranscriptMirrorProtobufDecodeError("a field is numbered zero");
    if (wireType === LENGTH_DELIMITED && wanted.has(fieldNumber)) {
      collected.get(fieldNumber)?.push(reader.lengthDelimited());
      continue;
    }
    reader.skip(wireType, fieldNumber);
  }
  return collected;
}

/** The three reference lists a stored conversation state holds; a list the record does not carry is empty. */
export function decodeTranscriptMirrorConversationState(bytes: Uint8Array): TranscriptMirrorConversationState {
  const fields = collectLengthDelimited(bytes, new Set(Object.values(STATE)));
  return {
    rootPromptMessagesJson: fields.get(STATE.rootPromptMessagesJson) ?? [],
    turns: fields.get(STATE.turns) ?? [],
    summaryArchives: fields.get(STATE.summaryArchives) ?? [],
  };
}

/** The ids of the messages an archive says it summarized. */
export function decodeSummaryArchiveMessageIds(bytes: Uint8Array): readonly Uint8Array[] {
  return collectLengthDelimited(bytes, new Set([SUMMARY_ARCHIVE.summarizedMessages])).get(SUMMARY_ARCHIVE.summarizedMessages) ?? [];
}
