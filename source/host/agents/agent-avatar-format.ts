/** Image signatures the conversation surface accepts for an agent picture. */
export function sniffAvatarMimeType(bytes: Uint8Array): string | null {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, offset) => bytes[offset] === byte)) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(view.toString("latin1", 0, 6))) return "image/gif";
  if (bytes.length >= 12 && view.toString("latin1", 0, 4) === "RIFF" && view.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }

  const header = view.toString("utf8", 0, Math.min(bytes.length, 1024))
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  return header.startsWith("<") && header.includes("<svg") ? "image/svg+xml" : null;
}
