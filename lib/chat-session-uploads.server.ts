import 'server-only'

import type { AgentPromptAttachment, AgentPromptFileAttachment } from '@/lib/agent-runtime/events'
import { createHash } from 'node:crypto'

interface UploadRow {
  id: string
  batch_id: string
  filename: string
  relative_path: string | null
  media_type: string
  size_bytes: number
  sha256: string
  content_base64: string
}

type RpcClient = {
  schema(name: string): {
    rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string } | null }>
  }
}

export type ResolvedPromptAttachment = Exclude<AgentPromptAttachment, AgentPromptFileAttachment> | (AgentPromptFileAttachment & { contentBase64: string })

function rowMatchesAttachment(row: UploadRow, attachment: AgentPromptFileAttachment): boolean {
  if (row.id !== attachment.uploadId || row.batch_id !== attachment.batchId
    || row.filename !== attachment.filename || (row.relative_path ?? undefined) !== attachment.relativePath
    || row.media_type !== attachment.mediaType || row.size_bytes !== attachment.sizeBytes
    || row.sha256 !== attachment.sha256) return false
  let content: Buffer
  try { content = Buffer.from(row.content_base64, 'base64') } catch { return false }
  return content.byteLength === attachment.sizeBytes
    && createHash('sha256').update(content).digest('hex') === attachment.sha256
}

export async function resolvePromptFileAttachments(
  db: RpcClient,
  sessionId: string,
  userId: string,
  attachments: AgentPromptAttachment[],
): Promise<ResolvedPromptAttachment[]> {
  const files = attachments.filter((attachment): attachment is AgentPromptFileAttachment => attachment.type === 'file')
  if (!files.length) return attachments as ResolvedPromptAttachment[]
  const { data, error } = await db.schema('openlink').rpc('resolve_chat_session_uploads', {
    p_session_id: sessionId,
    p_user_id: userId,
    p_ids: files.map((file) => file.uploadId),
  })
  if (error) throw new Error('UPLOAD_RESOLVE_FAILED')
  const rows = Array.isArray(data) ? data as UploadRow[] : []
  const byId = new Map(rows.map((row) => [row.id, row]))
  if (rows.length !== files.length || files.some((file) => {
    const row = byId.get(file.uploadId)
    return !row || !rowMatchesAttachment(row, file)
  })) throw new Error('UPLOAD_NOT_FOUND')
  return attachments.map((attachment) => {
    if (attachment.type !== 'file') return attachment
    return { ...attachment, contentBase64: byId.get(attachment.uploadId)!.content_base64 }
  })
}
