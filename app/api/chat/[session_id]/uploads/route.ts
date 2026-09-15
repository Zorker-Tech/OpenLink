import { createHash } from 'node:crypto'
import { parsePromptAttachments } from '@/lib/agent-runtime/prompt-attachments'
import type { AgentPromptFileAttachment } from '@/lib/agent-runtime/events'
import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

const MAX_FILES_PER_REQUEST = 16
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_REQUEST_BYTES = 12 * 1024 * 1024

interface UploadInput {
  id?: unknown
  batchId?: unknown
  filename?: unknown
  relativePath?: unknown
  mediaType?: unknown
  dataUrl?: unknown
}

async function authenticatedSession(sessionId: string) {
  if (!isChatSessionId(sessionId)) return { response: Response.json({ error: 'INVALID_SESSION' }, { status: 404 }) } as const
  const db = await createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return { response: Response.json({ error: 'AUTH_REQUIRED' }, { status: 401 }) } as const
  const session = await getChatSession(db, user.id, sessionId)
  if (!session) return { response: Response.json({ error: 'SESSION_NOT_FOUND' }, { status: 404 }) } as const
  return { db, user } as const
}

function decodeUpload(value: unknown): { attachment: AgentPromptFileAttachment; contentBase64: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as UploadInput
  const id = typeof input.id === 'string' ? input.id : ''
  const batchId = typeof input.batchId === 'string' ? input.batchId : ''
  const filename = typeof input.filename === 'string' ? input.filename.trim().slice(0, 240) : ''
  const relativePath = typeof input.relativePath === 'string' ? input.relativePath : undefined
  const mediaType = typeof input.mediaType === 'string' && input.mediaType.trim()
    ? input.mediaType.trim().toLowerCase().slice(0, 160)
    : 'application/octet-stream'
  const dataUrl = typeof input.dataUrl === 'string' ? input.dataUrl : ''
  const prefix = `data:${mediaType};base64,`
  if (!dataUrl.startsWith(prefix) || dataUrl.length > 2_800_000) return null
  const contentBase64 = dataUrl.slice(prefix.length)
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)) return null
  const content = Buffer.from(contentBase64, 'base64')
  if (content.byteLength > MAX_FILE_BYTES) return null
  const attachment: AgentPromptFileAttachment = {
    type: 'file', uploadId: id, batchId, filename, mediaType,
    ...(relativePath ? { relativePath } : {}),
    sizeBytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
  }
  const parsed = parsePromptAttachments([attachment])
  return parsed?.[0]?.type === 'file' ? { attachment: parsed[0], contentBase64 } : null
}

export async function POST(request: Request, { params }: { params: Promise<{ session_id: string }> }) {
  const { session_id: sessionId } = await params
  const auth = await authenticatedSession(sessionId)
  if ('response' in auth) return auth.response
  let body: { files?: unknown }
  try { body = await request.json() as typeof body } catch { return Response.json({ error: 'INVALID_BODY' }, { status: 400 }) }
  if (!Array.isArray(body.files) || !body.files.length || body.files.length > MAX_FILES_PER_REQUEST) {
    return Response.json({ error: 'INVALID_FILES' }, { status: 400 })
  }
  const decoded = body.files.map(decodeUpload)
  if (decoded.some((file) => !file)) return Response.json({ error: 'INVALID_FILE' }, { status: 400 })
  const uploads = decoded as Array<NonNullable<(typeof decoded)[number]>>
  if (uploads.reduce((total, file) => total + file.attachment.sizeBytes, 0) > MAX_REQUEST_BYTES) {
    return Response.json({ error: 'UPLOAD_TOO_LARGE' }, { status: 413 })
  }

  const registered: AgentPromptFileAttachment[] = []
  for (const upload of uploads) {
    const attachment = upload.attachment
    const { data, error } = await auth.db.schema('openlink').rpc('register_chat_session_upload', {
      p_id: attachment.uploadId,
      p_batch_id: attachment.batchId,
      p_session_id: sessionId,
      p_user_id: auth.user.id,
      p_filename: attachment.filename,
      p_relative_path: attachment.relativePath ?? null,
      p_media_type: attachment.mediaType,
      p_size_bytes: attachment.sizeBytes,
      p_sha256: attachment.sha256,
      p_content_base64: upload.contentBase64,
    })
    if (error || !Array.isArray(data) || !data.length) {
      const quota = error?.message?.includes('quota exceeded')
      return Response.json({ error: quota ? 'UPLOAD_QUOTA_EXCEEDED' : 'UPLOAD_FAILED' }, { status: quota ? 409 : 500 })
    }
    registered.push(attachment)
  }
  return Response.json({ attachments: registered }, { status: 201 })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ session_id: string }> }) {
  const { session_id: sessionId } = await params
  const auth = await authenticatedSession(sessionId)
  if ('response' in auth) return auth.response
  let body: { ids?: unknown }
  try { body = await request.json() as typeof body } catch { return Response.json({ error: 'INVALID_BODY' }, { status: 400 }) }
  const ids = Array.isArray(body.ids) && body.ids.length <= 24 && body.ids.every((id) => typeof id === 'string') ? body.ids as string[] : null
  if (!ids) return Response.json({ error: 'INVALID_UPLOAD_IDS' }, { status: 400 })
  const { error } = await auth.db.schema('openlink').rpc('delete_chat_session_uploads', {
    p_session_id: sessionId,
    p_user_id: auth.user.id,
    p_ids: ids,
  })
  if (error) return Response.json({ error: 'UPLOAD_DELETE_FAILED' }, { status: 500 })
  return Response.json({ ok: true })
}
