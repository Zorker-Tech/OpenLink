import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import type { BlobType, Serde } from "../../../packages/agent-kv/serde.ts"
import {
  ProtobufBlobSerde,
  type GeneratedBinaryMessage,
  type GeneratedMessageCodec,
} from "./protobuf-blob-serde-adapter.ts"

class RedactedProtoSerde<Plain extends GeneratedBinaryMessage, Redacted> implements Serde<Redacted> {
  private readonly wireSerde: ProtobufBlobSerde<Plain>

  constructor(
    messageType: GeneratedMessageCodec<Plain>,
    private readonly toRedacted: (entryValue: Plain, privacySetting: PrivacyMode) => Redacted,
    private readonly fromRedacted: (entryValue: Redacted, purpose: PrivacyCapability) => Plain,
    private readonly privacySetting: PrivacyMode,
  ) {
    this.wireSerde = new ProtobufBlobSerde(messageType)
  }

  serialize(entryValue: Redacted): Uint8Array {
    return this.wireSerde.serialize(this.fromRedacted(entryValue, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED))
  }

  deserialize(storedBytes: Uint8Array): Redacted {
    return this.toRedacted(this.wireSerde.deserialize(storedBytes), this.privacySetting)
  }

  getBlobType(): BlobType {
    return this.wireSerde.getBlobType()
  }
}

/** Persist a redacted view by encoding its generated wire value and reapplying privacy on read. */
export function createRedactedProtoSerde<Plain extends GeneratedBinaryMessage, Redacted>(
  messageType: GeneratedMessageCodec<Plain>,
  toRedacted: (entryValue: Plain, privacySetting: PrivacyMode) => Redacted,
  fromRedacted: (entryValue: Redacted, purpose: PrivacyCapability) => Plain,
  privacySetting: PrivacyMode,
): Serde<Redacted> {
  return new RedactedProtoSerde(messageType, toRedacted, fromRedacted, privacySetting)
}
