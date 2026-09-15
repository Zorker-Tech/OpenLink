import type { AgentPromptAttachment } from '@/lib/agent-runtime/events'

export function parsePromptAttachments(value: unknown): AgentPromptAttachment[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 24) return null
  let encodedImageBytes = 0
  let textBytes = 0
  let imageCount = 0
  let textCount = 0
  let instructionCount = 0
  let referenceCount = 0
  let fileCount = 0
  let fileBytes = 0
  const uploadIds = new Set<string>()
  const attachments: AgentPromptAttachment[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return null
    const item = candidate as Record<string, unknown>
    const mediaType = typeof item.mediaType === 'string' ? item.mediaType.toLowerCase() : ''
    const filename = typeof item.filename === 'string' ? item.filename.trim().slice(0, 240) : undefined
    if (item.type === 'file') {
      const uploadId = typeof item.uploadId === 'string' ? item.uploadId : ''
      const batchId = typeof item.batchId === 'string' ? item.batchId : ''
      const relativePath = typeof item.relativePath === 'string' ? item.relativePath : undefined
      const sizeBytes = typeof item.sizeBytes === 'number' ? item.sizeBytes : -1
      const sha256 = typeof item.sha256 === 'string' ? item.sha256.toLowerCase() : ''
      fileCount += 1
      fileBytes += sizeBytes
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      const safeFilename = Boolean(filename && filename !== '.' && filename !== '..' && ![/[/\\]/, /[\u0000-\u001f\u007f]/].some((pattern) => pattern.test(filename)))
      const safeRelativePath = relativePath === undefined || (relativePath.length <= 1024
        && !relativePath.startsWith('/') && !relativePath.includes('\\') && !relativePath.includes('//')
        && !/[\u0000-\u001f\u007f]/.test(relativePath)
        && relativePath.split('/').every((segment) => segment && segment !== '.' && segment !== '..'))
      if (!uuid.test(uploadId) || !uuid.test(batchId) || uploadIds.has(uploadId)
        || !safeFilename || !safeRelativePath || !mediaType || mediaType.length > 160
        || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > 2 * 1024 * 1024
        || !/^[a-f0-9]{64}$/.test(sha256) || fileCount > 16 || fileBytes > 12 * 1024 * 1024) return null
      uploadIds.add(uploadId)
      attachments.push({ type: 'file', uploadId, batchId, mediaType, filename: filename!, ...(relativePath ? { relativePath } : {}), sizeBytes, sha256 })
      continue
    }
    if (item.type === 'reference') {
      const referenceType: 'file' | 'thread' | '' = item.referenceType === 'file' || item.referenceType === 'thread' ? item.referenceType : ''
      const name = typeof item.name === 'string' ? item.name.trim().slice(0, 160) : ''
      const path = typeof item.path === 'string' ? item.path : ''
      referenceCount += 1
      if (!referenceType || !name || referenceCount > 16 || path.length > 1024 || path.includes('\0')
        || (referenceType === 'thread' && !/^thread:\/\/[A-Za-z0-9_-]{1,64}$/.test(path))
        || (referenceType === 'file' && (!path || /^\w+:\/\//.test(path)))) return null
      attachments.push({ type: 'reference', referenceType, name, path })
      continue
    }
    if (item.type === 'text') {
      const text = typeof item.text === 'string' ? item.text : ''
      const bytes = new TextEncoder().encode(text).byteLength
      textCount += 1
      textBytes += bytes
      if (mediaType !== 'text/plain' || !text || textCount > 4 || bytes > 256 * 1024 || textBytes > 512 * 1024) return null
      attachments.push({ type: 'text', mediaType: 'text/plain', text, ...(filename ? { filename } : {}) })
      continue
    }
    if (item.type === 'instruction') {
      const name = typeof item.name === 'string' ? item.name.trim().slice(0, 160) : ''
      const text = typeof item.text === 'string' ? item.text : ''
      const bytes = new TextEncoder().encode(text).byteLength
      instructionCount += 1
      if (!name || !text || instructionCount > 8 || bytes > 64 * 1024) return null
      attachments.push({ type: 'instruction', name, text })
      continue
    }
    const url = typeof item.url === 'string' ? item.url : ''
    imageCount += 1
    if (item.type !== 'image' || imageCount > 4 || !/^image\/(?:png|jpeg|webp|gif)$/.test(mediaType)) return null
    if (!url.startsWith(`data:${mediaType};base64,`) || url.length > 3_000_000) return null
    encodedImageBytes += url.length
    if (encodedImageBytes > 12_000_000) return null
    attachments.push({ type: 'image', mediaType, url, ...(filename ? { filename } : {}) })
  }
  return attachments
}
