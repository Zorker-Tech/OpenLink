import { normalizeAccessMode, type AccessMode } from './access-firewall.js'

export interface AccessResolver {
  resolveAccessMode(sessionId: string): Promise<AccessMode>
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/$/, '')
}

/**
 * Resolves a chat session's authoritative access mode from the OpenLink
 * control plane. The Agent Host uses the result to gate MCP operations, so the
 * agent cannot self-report a privilege it was not granted.
 */
export class SupabasePostgrestAccessResolver implements AccessResolver {
  private readonly baseUrl: string
  private readonly serviceRoleKey: string
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly timeoutMs: number

  constructor(options: { url: string; serviceRoleKey: string; fetch?: typeof globalThis.fetch; timeoutMs?: number }) {
    this.baseUrl = normalizeUrl(options.url)
    this.serviceRoleKey = options.serviceRoleKey.trim()
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 8_000)
  }

  async resolveAccessMode(sessionId: string): Promise<AccessMode> {
    const params = new URLSearchParams({
      select: 'access_mode',
      id: `eq.${sessionId}`,
      limit: '1',
    })
    const response = await this.fetchImpl(`${this.baseUrl}/rest/v1/chat_sessions?${params.toString()}`, {
      method: 'GET',
      headers: {
        apikey: this.serviceRoleKey,
        Authorization: `Bearer ${this.serviceRoleKey}`,
        Accept: 'application/json',
        'Accept-Profile': 'openlink',
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) throw new Error(`Supabase access mode lookup failed (${response.status})`)
    const rows = await response.json() as Array<{ access_mode?: unknown }>
    return normalizeAccessMode(rows[0]?.access_mode)
  }
}

export function createAccessModeResolver(env: NodeJS.ProcessEnv = process.env): AccessResolver | undefined {
  const url = env.OPENLINK_SUPABASE_URL?.trim() || env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const serviceRoleKey = env.OPENLINK_SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !serviceRoleKey) return undefined
  return new SupabasePostgrestAccessResolver({ url, serviceRoleKey })
}
