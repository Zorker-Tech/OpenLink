import { createHash } from 'node:crypto'

export interface TextChunk {
  index: number
  content: string
  hash: string
  tokenCount: number
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Character based chunking is deterministic and language agnostic. The API
 * stores tokenCount as an estimate; provider-specific tokenization belongs in
 * the embedding adapter and must not change chunk identity unexpectedly.
 */
export function chunkText(text: string, size: number, overlap: number): TextChunk[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []
  const safeOverlap = Math.min(Math.max(0, overlap), Math.max(0, size - 1))
  const step = Math.max(1, size - safeOverlap)
  const chunks: TextChunk[] = []
  for (let start = 0; start < normalized.length; start += step) {
    let end = Math.min(normalized.length, start + size)
    if (end < normalized.length) {
      const boundary = Math.max(normalized.lastIndexOf('\n', end), normalized.lastIndexOf(' ', end))
      if (boundary > start + Math.floor(size * 0.55)) end = boundary
    }
    const content = normalized.slice(start, end).trim()
    if (content) chunks.push({ index: chunks.length, content, hash: hash(content), tokenCount: Math.max(1, Math.ceil(content.length / 4)) })
    if (end >= normalized.length) break
  }
  return chunks
}
