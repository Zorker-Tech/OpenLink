import { getT } from '@/lib/i18n/server'
import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { createClient } from '@/utils/supabase/server'

export interface BrowserPreviewTarget {
  id: string
  label: string
  source: 'sandbox'
  sessionId?: string
  port: number
  sandboxId: string
  lastSeenAt: string
}

function hostConfig() {
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
  const apiToken = process.env.OPENLINK_AGENT_API_TOKEN
  if (!baseUrl || !apiToken) return null
  return { baseUrl, apiToken }
}

function safeTarget(value: unknown): BrowserPreviewTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const target = value as Record<string, unknown>
  if (typeof target.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}:[0-9]{1,5}$/.test(target.id)) return null
  if (typeof target.label !== 'string' || !target.label.trim()) return null
  if (typeof target.port !== 'number' || !Number.isSafeInteger(target.port) || target.port <= 0 || target.port > 65_535) return null
  if (typeof target.sandboxId !== 'string' || !target.sandboxId) return null
  return {
    id: target.id,
    label: target.label.slice(0, 160),
    source: 'sandbox',
    ...(typeof target.sessionId === 'string' && target.sessionId.length <= 128 ? { sessionId: target.sessionId } : {}),
    port: target.port,
    sandboxId: target.sandboxId.slice(0, 160),
    lastSeenAt: typeof target.lastSeenAt === 'string' ? target.lastSeenAt : new Date().toISOString(),
  }
}

type ChatSessionRecord = NonNullable<Awaited<ReturnType<typeof getChatSession>>>

/** List live Project development servers for one authenticated chat session. */
export async function listBrowserPreviewTargets(chatSessionId: string): Promise<
  | { ok: true; targets: BrowserPreviewTarget[]; chat: ChatSessionRecord }
  | { ok: false; status: number; error: { code: string; message: string; recoverable?: boolean } }
> {
  const { t } = await getT()
  const config = hostConfig()
  if (!config) return { ok: false, status: 503, error: { code: 'BROWSER_HOST_NOT_CONFIGURED', message: 'Browser Host is not configured', recoverable: true } }
  if (!isChatSessionId(chatSessionId)) return { ok: false, status: 404, error: { code: 'SESSION_NOT_FOUND', message: 'Chat session was not found' } }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, status: 401, error: { code: 'AUTH_REQUIRED', message: 'Authentication is required' } }
  const chat = await getChatSession(supabase, user.id, chatSessionId)
  if (!chat) return { ok: false, status: 404, error: { code: 'SESSION_NOT_FOUND', message: 'Chat session was not found' } }
  try {
    const url = new URL(`/v1/projects/${encodeURIComponent(chat.project_id)}/preview-targets`, config.baseUrl)
    url.searchParams.set('sessionId', chatSessionId)
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.apiToken}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    })
    const payload = await response.json().catch(() => null) as { targets?: unknown; error?: { message?: string } } | null
    if (!response.ok) {
      return { ok: false, status: 503, error: { code: 'PREVIEW_DISCOVERY_FAILED', message: payload?.error?.message ?? t('无法发现项目开发服务器'), recoverable: true } }
    }
    const targets = Array.isArray(payload?.targets)
      ? payload.targets.flatMap((value) => { const target = safeTarget(value); return target ? [target] : [] })
      : []
    // Prefer the current session's own server, then the conventional ports.
    targets.sort((left, right) => Number(right.sessionId === chatSessionId) - Number(left.sessionId === chatSessionId))
    return { ok: true, targets, chat }
  } catch (error) {
    return {
      ok: false,
      status: 503,
      error: {
        code: 'PREVIEW_DISCOVERY_FAILED',
        message: error instanceof Error ? error.message : t('无法发现项目开发服务器'),
        recoverable: true,
      },
    }
  }
}

export { hostConfig }
