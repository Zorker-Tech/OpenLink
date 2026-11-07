import { getT } from '@/lib/i18n/server'
import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { getProject, type ProjectSummary } from '@/lib/projects'
import { createClient } from '@/utils/supabase/server'
import { isPreviewTargetId } from '@/lib/browser-preview-target-id'

export interface BrowserPreviewTarget {
  id: string
  label: string
  source: 'sandbox'
  port: number
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
  if (!isPreviewTargetId(target.id)) return null
  if (typeof target.label !== 'string' || !target.label.trim()) return null
  if (typeof target.port !== 'number' || !Number.isSafeInteger(target.port) || target.port <= 0 || target.port > 65_535) return null
  return {
    id: target.id,
    label: target.label.slice(0, 160),
    source: 'sandbox',
    port: target.port,
    lastSeenAt: typeof target.lastSeenAt === 'string' ? target.lastSeenAt : new Date().toISOString(),
  }
}

type ChatSessionRecord = NonNullable<Awaited<ReturnType<typeof getChatSession>>>
type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>

export interface BrowserPreviewScopeInput {
  chatSessionId?: string
  projectId?: string
}

export type BrowserPreviewScopeResult =
  | { ok: true; project: ProjectSummary; workspaceId: string; chat?: ChatSessionRecord; preferredSessionId?: string }
  | { ok: false; status: number; error: { code: string; message: string; recoverable?: boolean } }

const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type BrowserPreviewDiscoveryResult =
  | { ok: true; targets: BrowserPreviewTarget[] }
  | { ok: false; status: number; error: { code: string; message: string; recoverable?: boolean } }

/** Resolve a Preview project from a caller-owned chat or an authorized project id. */
export async function resolveBrowserPreviewScope(
  supabase: ServerSupabaseClient,
  userId: string,
  input: BrowserPreviewScopeInput,
): Promise<BrowserPreviewScopeResult> {
  let chat: ChatSessionRecord | null = null
  let projectId = input.projectId ?? ''

  if (input.chatSessionId !== undefined) {
    if (!isChatSessionId(input.chatSessionId)) {
      return { ok: false, status: 404, error: { code: 'SESSION_NOT_FOUND', message: 'Chat session was not found' } }
    }
    chat = await getChatSession(supabase, userId, input.chatSessionId)
    if (!chat) return { ok: false, status: 404, error: { code: 'SESSION_NOT_FOUND', message: 'Chat session was not found' } }
    if (projectId && projectId !== chat.project_id) {
      return { ok: false, status: 404, error: { code: 'PROJECT_NOT_FOUND', message: 'Project was not found' } }
    }
    projectId = chat.project_id
  }

  if (!PROJECT_ID_PATTERN.test(projectId)) {
    return { ok: false, status: 404, error: { code: 'PROJECT_NOT_FOUND', message: 'Project was not found' } }
  }

  const project = await getProject(supabase, projectId)
  if (!project || (chat && project.workspace_id !== chat.workspace_id)) {
    return { ok: false, status: 404, error: { code: 'PROJECT_NOT_FOUND', message: 'Project was not found' } }
  }
  if (project.status === 'archived') {
    return { ok: false, status: 409, error: { code: 'PROJECT_ARCHIVED', message: 'Archived projects cannot open Preview' } }
  }

  return {
    ok: true,
    project,
    workspaceId: project.workspace_id,
    ...(chat ? { chat, preferredSessionId: chat.id } : {}),
  }
}

export async function discoverBrowserPreviewTargets(projectId: string, preferredSessionId?: string): Promise<BrowserPreviewDiscoveryResult> {
  const { t } = await getT()
  const config = hostConfig()
  if (!config) return { ok: false, status: 503, error: { code: 'BROWSER_HOST_NOT_CONFIGURED', message: 'Browser Host is not configured', recoverable: true } }
  try {
    const url = new URL(`/v1/projects/${encodeURIComponent(projectId)}/preview-targets`, config.baseUrl)
    if (preferredSessionId) url.searchParams.set('sessionId', preferredSessionId)
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
    return { ok: true, targets }
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

/** List live development servers for an authenticated Preview project. */
export async function listBrowserPreviewTargets(input: BrowserPreviewScopeInput): Promise<
  | (Extract<BrowserPreviewScopeResult, { ok: true }> & { targets: BrowserPreviewTarget[] })
  | Extract<BrowserPreviewScopeResult, { ok: false }>
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, status: 401, error: { code: 'AUTH_REQUIRED', message: 'Authentication is required' } }
  const scope = await resolveBrowserPreviewScope(supabase, user.id, input)
  if (!scope.ok) return scope
  const discovery = await discoverBrowserPreviewTargets(scope.project.id, scope.preferredSessionId)
  if (!discovery.ok) return discovery
  return { ...scope, targets: discovery.targets }
}

export { hostConfig }
