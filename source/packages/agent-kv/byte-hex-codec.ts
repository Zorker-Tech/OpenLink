export function encodeHex(value: Uint8Array): string {
  try {
    return Buffer.from(value).toString("hex");
  } catch {
    return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
}

export function decodeHex(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.trim().toLowerCase();
  if (normalized.length % 2 !== 0) throw new Error("Invalid hex string length");

  const output = new Uint8Array(normalized.length / 2);
  for (let offset = 0; offset < normalized.length; offset += 2) {
    output[offset / 2] = Number.parseInt(normalized.slice(offset, offset + 2), 16);
  }
  return output;
}
