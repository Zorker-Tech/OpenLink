import { createHmac } from 'node:crypto'

const PREVIEW_TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function isPreviewTargetId(value: unknown): value is string {
  return typeof value === 'string' && PREVIEW_TARGET_ID_PATTERN.test(value)
}

/**
 * Produce a stable browser-facing identifier without disclosing the sandbox
 * id, Project id, port tuple, or upstream proxy credentials. The OpenSandbox
 * API key is Project-scoped and is already available only inside Agent Host.
 */
export function createPreviewTargetId(secret: string, projectId: string, sandboxId: string, port: number): string {
  if (secret.length < 16) throw new Error('PREVIEW_TARGET_ID_SECRET_INVALID')
  if (!projectId || !sandboxId || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PREVIEW_TARGET_ID_INPUT_INVALID')
  }
  return createHmac('sha256', secret)
    .update(`openlink.preview-target.v1\0${projectId}\0${sandboxId}\0${port}`)
    .digest('base64url')
}
