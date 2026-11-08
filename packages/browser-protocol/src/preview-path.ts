const MAX_PREVIEW_PATH_LENGTH = 2048
const PREVIEW_SESSION_PATH = /^\/v1\/browser\/(?:gateway\/)?sessions\/[^/]+\/preview(?=\/|$)/

/**
 * Accept only a same-origin pathname for a managed Preview route. Query
 * parameters and fragments are deliberately excluded from durable state.
 */
export function sanitizePreviewPagePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_PREVIEW_PATH_LENGTH) return null
  if (!value.startsWith('/') || value.startsWith('//') || /[\\?#\u0000-\u001f\u007f]/.test(value)) return null

  for (const segment of value.split('/')) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (decoded === '.' || decoded === '..' || /[\\/\u0000-\u001f\u007f]/.test(decoded)) return null
  }

  try {
    return new URL(value, 'https://preview.invalid').pathname
  } catch {
    return null
  }
}

/** Extract a route from a Browser Host Preview URL without retaining its session id. */
export function previewPagePathFromAddress(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_PREVIEW_PATH_LENGTH + 512) return null
  let pathname: string
  try {
    pathname = new URL(value, 'https://preview.invalid').pathname
  } catch {
    return null
  }
  const prefix = PREVIEW_SESSION_PATH.exec(pathname)
  if (!prefix) return null
  return sanitizePreviewPagePath(pathname.slice(prefix[0].length) || '/')
}
