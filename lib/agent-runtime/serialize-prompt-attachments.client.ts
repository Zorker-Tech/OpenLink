import type { Translator } from '@/lib/i18n/messages'

import type {
  AgentPromptAttachment,
  AgentPromptFileAttachment,
  AgentPromptInstructionAttachment,
  AgentPromptReferenceAttachment,
  AgentPromptTextAttachment,
} from '@/lib/agent-runtime/events'

export interface ClientPromptFile {
  batchId: string
  filename?: string
  mediaType: string
  relativePath?: string
  uploadId: string
  url: string
}

/**
 * Fallback for callers that render without a locale provider (tests, stories,
 * isolated adapters). It mirrors `translate()` from lib/i18n/messages: no
 * catalog lookup, but placeholders still resolve.
 */
const sourceTranslator: Translator = (source, values) => values
  ? source.replace(/\{(\w+)\}/g, (match, key: string) => values[key] === undefined ? match : String(values[key]))
  : source

/** Convert browser input files into OpenLink's agent-independent attachment
 * protocol. Non-image bytes are stored privately after a session exists;
 * only bounded metadata continues into the queue and event stream. */
export async function serializePromptAttachments(
  sessionId: string,
  files: ClientPromptFile[],
  pastedTextAttachments: Array<AgentPromptTextAttachment & { id: string }> = [],
  referenceAttachments: Array<AgentPromptReferenceAttachment & { id: string }> = [],
  instructionAttachments: Array<AgentPromptInstructionAttachment & { id: string }> = [],
  t: Translator = sourceTranslator,
): Promise<AgentPromptAttachment[]> {
  if (files.reduce((bytes, file) => bytes + file.url.length, 0) > 12_000_000) throw new Error(t('附件总大小不能超过 12 MB'))
  const images: AgentPromptAttachment[] = files.flatMap((file) => !file.relativePath && file.mediaType.startsWith('image/') && file.url.startsWith('data:image/')
    ? [{ type: 'image' as const, mediaType: file.mediaType, url: file.url, ...(file.filename ? { filename: file.filename } : {}) }]
    : [])
  const ordinaryFiles = files.filter((file) => Boolean(file.relativePath) || !file.mediaType.startsWith('image/') || !file.url.startsWith('data:image/'))
  let uploaded: AgentPromptFileAttachment[] = []
  if (ordinaryFiles.length) {
    const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: ordinaryFiles.map((file) => {
        const content = file.url.match(/^data:[^,]*;base64,([A-Za-z0-9+/]*={0,2})$/)?.[1]
        if (content === undefined) throw new Error(t('无法读取附件 {name}', { name: file.filename ?? 'file' }))
        const mediaType = file.mediaType || 'application/octet-stream'
        return {
          id: file.uploadId,
          batchId: file.batchId,
          filename: file.filename ?? 'file',
          ...(file.relativePath ? { relativePath: file.relativePath } : {}),
          mediaType,
          dataUrl: `data:${mediaType};base64,${content}`,
        }
      }) }),
    })
    const payload = await response.json().catch(() => null) as { attachments?: AgentPromptFileAttachment[]; error?: string } | null
    if (!response.ok || !Array.isArray(payload?.attachments)) {
      throw new Error(payload?.error === 'UPLOAD_QUOTA_EXCEEDED' ? t('本会话的附件存储空间已满') : t('文件上传失败，请重试'))
    }
    uploaded = payload.attachments
  }
  return [
    ...images,
    ...uploaded,
    ...pastedTextAttachments.map(({ id: _id, ...attachment }) => attachment),
    ...referenceAttachments.map(({ id: _id, ...attachment }) => attachment),
    ...instructionAttachments.map(({ id: _id, ...attachment }) => attachment),
  ]
}
