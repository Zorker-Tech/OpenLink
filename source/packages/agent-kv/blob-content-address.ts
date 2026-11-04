/** Uses a private byte view when the input can be mutated by another thread. */
export function toUint8Array(value: Uint8Array): Uint8Array {
  return typeof SharedArrayBuffer !== "undefined" && value.buffer instanceof SharedArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

function snapshotBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = toUint8Array(value)
  const snapshot = new Uint8Array(bytes.byteLength)
  snapshot.set(bytes)
  return snapshot
}

/** Computes an immutable content address from a snapshot of the caller's bytes. */
export async function getBlobId(value: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await crypto.subtle.digest("SHA-256", snapshotBytes(value).buffer)
  return new Uint8Array(digest)
}
