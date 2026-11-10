import type { BlobType, Serde } from "../../../packages/agent-kv/serde-contracts.ts";

export interface GeneratedBinaryMessage {
  toBinary(): Uint8Array;
}

export interface GeneratedMessageCodec<Message extends GeneratedBinaryMessage> {
  readonly typeName: string;
  fromBinary(bytes: Uint8Array): Message;
}

/** Keeps generated binary messages at the interop boundary while presenting the host's generic blob interface. */
export class ProtobufBlobSerde<Message extends GeneratedBinaryMessage> implements Serde<Message> {
  constructor(private readonly codec: GeneratedMessageCodec<Message>) {}

  serialize(message: Message): Uint8Array {
    return message.toBinary();
  }

  deserialize(bytes: Uint8Array): Message {
    return this.codec.fromBinary(bytes);
  }

  getBlobType(): BlobType {
    return { kind: "proto", typeName: this.codec.typeName };
  }
}
