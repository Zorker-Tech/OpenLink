import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const RECEIPT_VERSION = 1
const RECEIPT_TTL_MS = 30 * 60 * 1000
const MAX_CLOCK_SKEW_MS = 30 * 1000
const DOMAIN = 'openlink.preview.screenshot-receipt.v1\0'

function signingKey(secret) {
  if (typeof secret !== 'string' || secret.length < 16) return null
  return createHmac('sha256', secret).update(DOMAIN).digest()
}

function imageDigest(image) {
  if (!Buffer.isBuffer(image) || image.length === 0) return null
  return createHash('sha256').update(image).digest('hex')
}

function receiptPayload({ userId, projectId, targetId, pagePath, viewport, targetRevision, image, issuedAt }) {
  const digest = imageDigest(image)
  if (!digest || typeof userId !== 'string' || typeof projectId !== 'string'
    || typeof targetId !== 'string' || typeof pagePath !== 'string'
    || !viewport || !Number.isSafeInteger(viewport.width) || !Number.isSafeInteger(viewport.height)
    || typeof targetRevision !== 'string' || !Number.isSafeInteger(issuedAt)) return null
  return {
    version: RECEIPT_VERSION,
    issuedAt,
    userId,
    projectId,
    targetId,
    pagePath,
    viewport: { width: viewport.width, height: viewport.height },
    targetRevision,
    imageSha256: digest,
  }
}

function signature(key, encodedPayload) {
  return createHmac('sha256', key).update(`${DOMAIN}${encodedPayload}`).digest('base64url')
}

/**
 * Sign a short-lived attestation for bytes captured from a stable Preview
 * target. The secret must stay in server environment state.
 *
 * @param {{secret: string, userId: string, projectId: string, targetId: string, pagePath: string, viewport: {width: number, height: number}, targetRevision: string, image: Buffer, now?: number}} input
 * @returns {string | null}
 */
export function createPreviewScreenshotReceipt(input) {
  const key = signingKey(input.secret)
  const payload = receiptPayload({ ...input, issuedAt: input.now ?? Date.now() })
  if (!key || !payload) return null
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${signature(key, encoded)}`
}

/**
 * Verify both the server signature and every value that an annotation binds
 * to the captured screenshot. The default age limit is 30 minutes.
 *
 * @param {{secret: string, receipt: unknown, expected: {userId: string, projectId: string, targetId: string, pagePath: string, viewport: {width: number, height: number}, targetRevision: string, image: Buffer}, now?: number}} input
 * @returns {boolean}
 */
export function verifyPreviewScreenshotReceipt(input) {
  const key = signingKey(input.secret)
  if (!key || typeof input.receipt !== 'string' || input.receipt.length > 2048) return false
  const parts = input.receipt.split('.')
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return false

  const expectedSignature = Buffer.from(signature(key, parts[0]))
  const actualSignature = Buffer.from(parts[1])
  if (expectedSignature.length !== actualSignature.length || !timingSafeEqual(expectedSignature, actualSignature)) return false

  let rawPayload
  let payload
  try {
    rawPayload = Buffer.from(parts[0], 'base64url').toString('utf8')
    payload = JSON.parse(rawPayload)
  } catch {
    return false
  }
  if (JSON.stringify(payload) !== rawPayload || payload?.version !== RECEIPT_VERSION
    || !Number.isSafeInteger(payload.issuedAt)) return false

  const now = input.now ?? Date.now()
  const age = now - payload.issuedAt
  if (age < -MAX_CLOCK_SKEW_MS || age > RECEIPT_TTL_MS) return false

  const expected = receiptPayload({ ...input.expected, issuedAt: payload.issuedAt })
  if (!expected) return false
  return JSON.stringify(payload) === JSON.stringify(expected)
}
