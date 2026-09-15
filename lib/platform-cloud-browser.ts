export type CloudConnectionSummary = {
  id: string
  issuer: 'https://auth.hydite.com'
  subject: string
  state: 'active' | 'refreshing' | 'reauth_required' | 'revoking' | 'revoked'
}
export class CloudBrowserError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.code = code }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const states = new Set(['active','refreshing','reauth_required','revoking','revoked'])
function id(value: string) {
  if (!uuid.test(value)) throw new CloudBrowserError('INVALID_CONNECTION')
  return value.toLowerCase()
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CloudBrowserError('INVALID_RESPONSE')
  return value as Record<string, unknown>
}

/** Browser-safe BFF client. No OAuth/model credentials are handled here. */
export function createCloudConnectionsBrowser(fetchImpl: typeof fetch = globalThis.fetch) {
  async function request(path: string, method: string, signal?: AbortSignal) {
    try {
      if (signal?.aborted) throw new CloudBrowserError('CANCELLED')
      const deadline = AbortSignal.timeout(15_000)
      const response = await fetchImpl('/api/platform/connections' + path, {
        method, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        headers: { accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      })
      if (signal?.aborted || deadline.aborted) {
        void response.body?.cancel().catch(() => {})
        throw new CloudBrowserError(signal?.aborted ? 'CANCELLED' : 'SERVICE_UNAVAILABLE')
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        throw new CloudBrowserError(response.status === 401 ? 'AUTHENTICATION_REQUIRED' : response.status === 409 ? 'CONNECTION_CONFLICT' : response.status === 429 ? 'RATE_LIMITED' : 'SERVICE_UNAVAILABLE')
      }
      if (response.redirected || Number(response.headers.get('content-length') ?? 0) > 65536) {
        void response.body?.cancel().catch(() => {})
        throw new CloudBrowserError('INVALID_RESPONSE')
      }
      const reader = response.body?.getReader()
      if (!reader) throw new CloudBrowserError('INVALID_RESPONSE')
      let bytes = 0, text = ''
      const decoder = new TextDecoder('utf-8', { fatal: true })
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.length
          if (bytes > 65536) throw new CloudBrowserError('INVALID_RESPONSE')
          text += decoder.decode(chunk.value, { stream: true })
        }
        text += decoder.decode()
        return record(JSON.parse(text))
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
    } catch (error) {
      if (error instanceof CloudBrowserError) throw error
      throw new CloudBrowserError(signal?.aborted ? 'CANCELLED' : 'SERVICE_UNAVAILABLE')
    }
  }
  return {
    async list(signal?: AbortSignal): Promise<CloudConnectionSummary[]> {
      const data = await request('', 'GET', signal)
      if (!Array.isArray(data.connections) || data.connections.length > 100) throw new CloudBrowserError('INVALID_RESPONSE')
      return data.connections.map(value => {
        const row = record(value)
        if (typeof row.id !== 'string' || !uuid.test(row.id) || row.issuer !== 'https://auth.hydite.com' ||
          typeof row.subject !== 'string' || !row.subject || row.subject.length > 255 || typeof row.state !== 'string' || !states.has(row.state))
          throw new CloudBrowserError('INVALID_RESPONSE')
        return { id: row.id, issuer: row.issuer, subject: row.subject, state: row.state } as CloudConnectionSummary
      })
    },
    async verify(connection: CloudConnectionSummary, signal?: AbortSignal) {
      const result = await request('/' + id(connection.id), 'GET', signal)
      if (result.connected === true && result.subject === connection.subject) return { connected: true as const }
      if (result.connected === false && typeof result.state === 'string' && ['reauth_required','revoking','revoked'].includes(result.state))
        return { connected: false as const, state: result.state as CloudConnectionSummary['state'] }
      throw new CloudBrowserError('INVALID_RESPONSE')
    },
    async start(signal?: AbortSignal) {
      const result = await request('/start', 'POST', signal)
      if (typeof result.authorizationUrl !== 'string' || result.authorizationUrl.length > 4096) throw new CloudBrowserError('INVALID_RESPONSE')
      const url = new URL(result.authorizationUrl)
      if (url.origin !== 'https://auth.hydite.com' || url.username || url.password || url.hash) throw new CloudBrowserError('INVALID_RESPONSE')
      return url.toString()
    },
    async disconnect(connectionId: string, signal?: AbortSignal) {
      const result = await request('/' + id(connectionId), 'DELETE', signal)
      if (result.revoked === true && result.revocationPending === false) return 'revoked' as const
      if (result.revoked === false && result.revocationPending === true) return 'pending' as const
      throw new CloudBrowserError('INVALID_RESPONSE')
    },
  }
}
