/**
 * Turning values into blobs and back.
 *
 * Everything an agent persists goes through a blob store, and a blob is addressed by the hash of its
 * bytes — so the serde is what decides what those bytes are. A serde also reports the kind of blob it
 * produces, which is what lets the store describe what it holds without decoding it.
 */

import { decodeHex, encodeHex } from "./byte-hex-codec.ts"
import type { BlobType, Serde } from "./serde-contracts.ts"

export type { BlobType, Serde } from "./serde-contracts.ts"
export { decodeHex as fromHex, encodeHex as toHex } from "./byte-hex-codec.ts"

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export class Utf8Serde implements Serde<string> {
  serialize(value: string): Uint8Array {
    return encoder.encode(value)
  }

  deserialize(blob: Uint8Array): string {
    return decoder.decode(blob)
  }

  getBlobType(): BlobType {
    return { kind: "string" }
  }
}

export const utf8Serde = new Utf8Serde()
