import type { Translator } from '@/lib/i18n/messages'

import type { AgentPromptTextAttachment } from './events'

export const PASTED_TEXT_ATTACHMENT_THRESHOLD = 2_000
export const PASTED_TEXT_ATTACHMENT_MAX_BYTES = 256 * 1024
export const PASTED_TEXT_ATTACHMENT_MAX_COUNT = 4

/**
 * Fallback for callers that render without a locale provider (tests, stories,
 * isolated adapters). It mirrors `translate()` from lib/i18n/messages: no
 * catalog lookup, but placeholders still resolve.
 */
const sourceTranslator: Translator = (source, values) => values
  ? source.replace(/\{(\w+)\}/g, (match, key: string) => values[key] === undefined ? match : String(values[key]))
  : source

export function pastedTextByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

export function shouldAttachPastedText(text: string): boolean {
  return text.length >= PASTED_TEXT_ATTACHMENT_THRESHOLD
}

export function createPastedTextAttachment(text: string, t: Translator = sourceTranslator): AgentPromptTextAttachment | null {
  if (!shouldAttachPastedText(text) || pastedTextByteLength(text) > PASTED_TEXT_ATTACHMENT_MAX_BYTES) return null
  return {
    type: 'text',
    mediaType: 'text/plain',
    text,
    filename: t('已粘贴的文本.txt'),
  }
}

export function insertRestoredPastedText(value: string, text: string, start: number, end = start) {
  const safeStart = Math.max(0, Math.min(start, value.length))
  const safeEnd = Math.max(safeStart, Math.min(end, value.length))
  const next = value.slice(0, safeStart) + text + value.slice(safeEnd)
  return { value: next, cursor: safeStart + text.length }
}
