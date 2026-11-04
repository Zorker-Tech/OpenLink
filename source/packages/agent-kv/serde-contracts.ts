export interface BlobType {
  readonly kind: string;
  readonly typeName?: string;
  readonly mimeType?: string;
}

export interface Serde<T> {
  serialize(value: T): Uint8Array;
  deserialize(blob: Uint8Array): T;
  getBlobType?(): BlobType;
}
