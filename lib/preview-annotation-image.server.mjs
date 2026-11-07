import { createHash } from 'node:crypto'

export const PREVIEW_ANNOTATION_BUCKET = 'openlink-preview-annotations'
export const PREVIEW_ANNOTATION_IMAGE_MAX_BYTES = 2_100_000
export const PREVIEW_ANNOTATION_DATA_URL_MAX_LENGTH = 2_800_050

const JPEG_DATA_URL_PREFIX = 'data:image/jpeg;base64,'
const JPEG_DATA_URL_PATTERN = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/

/** @param {Uint8Array} bytes */
function isJpeg(bytes) {
  return bytes.length >= 4
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
    && bytes[bytes.length - 2] === 0xff
    && bytes[bytes.length - 1] === 0xd9
}

/** @param {unknown} value @returns {Buffer | null} */
export function decodePreviewAnnotationImage(value) {
  if (typeof value !== 'string' || value.length > PREVIEW_ANNOTATION_DATA_URL_MAX_LENGTH) return null
  const match = JPEG_DATA_URL_PATTERN.exec(value)
  if (!match) return null
  const bytes = Buffer.from(match[1], 'base64')
  if (bytes.length > PREVIEW_ANNOTATION_IMAGE_MAX_BYTES
    || bytes.toString('base64') !== match[1]
    || !isJpeg(bytes)) return null
  return bytes
}

/** @param {Uint8Array} value @returns {string | null} */
export function previewAnnotationImageDataUrl(value) {
  if (value.length > PREVIEW_ANNOTATION_IMAGE_MAX_BYTES || !isJpeg(value)) return null
  return `${JPEG_DATA_URL_PREFIX}${Buffer.from(value).toString('base64')}`
}

/** @param {string} projectId @param {string} userId @param {string} annotationId @param {Uint8Array} image */
export function previewAnnotationObjectPath(projectId, userId, annotationId, image) {
  const digest = createHash('sha256').update(image).digest('hex')
  return `${projectId.toLowerCase()}/${userId.toLowerCase()}/${annotationId.toLowerCase()}-${digest}.jpg`
}

/** @param {unknown} value @param {string} projectId */
export function isPreviewAnnotationObjectPath(value, projectId) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) return false
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  const pattern = new RegExp(`^${projectId.toLowerCase()}/${uuid}/${uuid}-[a-f0-9]{64}[.]jpg$`)
  return pattern.test(value)
}
