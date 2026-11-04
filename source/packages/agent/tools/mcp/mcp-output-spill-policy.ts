export const MCP_TEXT_FILE_THRESHOLD_BYTES = 40_000

export function truncateMcpOutputUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8")
  if (bytes.byteLength <= maxBytes) return text

  const boundary = Math.max(0, Math.floor(maxBytes))
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, boundary))
  return decoded.endsWith("\uFFFD") ? decoded.slice(0, -1) : decoded
}

export function buildTruncatedMcpOutputText(text: string, inlineLimitBytes: number): string {
  const totalBytes = Buffer.byteLength(text, "utf8")
  const visibleText = truncateMcpOutputUtf8(text, inlineLimitBytes)
  const notice = `

[Output truncated: the full MCP tool output was ${totalBytes} bytes, which exceeds the inline limit of ${inlineLimitBytes} bytes, and could not be written to a file. The remainder was discarded; do not retry the same call expecting the full output.]`

  return visibleText + notice
}
