import 'server-only'

export class WorkHostError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly command: string,
  ) {
    super(message)
    this.name = 'WorkHostError'
  }
}

/**
 * Work-host stores each agent in its own SQLite database. A lost or partially
 * restored Work-host data root is recoverable because the OpenLink projection
 * row and the durable Code-mode event log still describe the Bot. Callers use
 * this predicate to recreate the Work-host agent instead of treating a missing
 * local store as an unrecoverable application error.
 */
export function isMissingWorkHostAgentError(error: unknown): boolean {
  return error instanceof WorkHostError
    && (error.status === 404 || /agent\s+[^\s]+\s+does not exist|agent missing|not found/i.test(error.message))
}

export interface WorkHostConfig {
  baseUrl: string
  apiToken: string
}

export interface WorkHostAgent {
  id: string
  name: string
  description: string
  title?: string
  avatarShape?: string | null
  avatarColor?: string | null
  avatarVersion?: string | null
  createdAt?: number
  updatedAt?: number
  lastEntry?: unknown
  lastMessagePreview?: string | null
  lastActivityAt?: number
  unreadCount?: number
  hasUnread?: boolean
}

export interface WorkHostCreateAgentResult {
  agent: WorkHostAgent
  transcript: unknown[]
}

export interface WorkHostAvatar {
  bytes: Uint8Array
  contentType: string
  etag: string | null
}

export function workHostConfig(): WorkHostConfig | null {
  const baseUrl = process.env.OPENLINK_WORK_HOST_URL?.replace(/\/+$/, '')
  const apiToken = process.env.OPENLINK_WORK_HOST_API_TOKEN
  return baseUrl && apiToken ? { baseUrl, apiToken } : null
}

export function isWorkHostConfigured(): boolean {
  return workHostConfig() !== null
}

function requiredConfig(): WorkHostConfig {
  const config = workHostConfig()
  if (!config) throw new WorkHostError('Work Host is not configured', 503, 'config')
  return config
}

async function request<T>(
  command: string,
  body?: unknown,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const config = requiredConfig()
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetch(`${config.baseUrl}/api/${command}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body ?? {}),
      cache: 'no-store',
      signal,
    })
  } catch (error) {
    throw new WorkHostError(
      error instanceof Error ? error.message : 'Work Host request failed',
      503,
      command,
    )
  }
  const payload = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    const detail = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error?: unknown }).error ?? '')
      : ''
    throw new WorkHostError(detail || `Work Host rejected ${command}`, response.status, command)
  }
  return payload as T
}

export async function createBotAgent(input: {
  name: string
  description: string
  avatarShape: string
  avatarColor: string
}): Promise<WorkHostCreateAgentResult> {
  return await request<WorkHostCreateAgentResult>('createBackgroundAgent', {
    name: input.name,
    description: input.description,
    avatarShape: input.avatarShape,
    avatarColor: input.avatarColor,
    origin: 'user',
    isIntroductionSuppressed: true,
  }, { timeoutMs: 60_000 })
}

export async function updateBotAgent(input: {
  id: string
  name: string
  description: string
  avatarShape?: string
  avatarColor?: string
}): Promise<WorkHostAgent | null> {
  return await request<WorkHostAgent | null>('updateAgent', {
    id: input.id,
    profile: {
      name: input.name,
      description: input.description,
      ...(input.avatarShape === undefined ? {} : { avatarShape: input.avatarShape }),
      ...(input.avatarColor === undefined ? {} : { avatarColor: input.avatarColor }),
    },
  })
}

export async function setBotAgentAvatar(agentId: string, pngBase64: string | null): Promise<void> {
  await request('setAgentAvatarBytes', {
    id: agentId,
    pngBase64,
  }, { timeoutMs: 30_000 })
}

export async function getBotAgentTranscript(agentId: string): Promise<Record<string, unknown>[]> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await request<unknown>('getAgentTranscript', { id: agentId }, { timeoutMs: 20_000 })
      return Array.isArray(result)
        ? result.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
        : []
    } catch (error) {
      lastError = error
      if (attempt > 0 || !(error instanceof WorkHostError) || error.status < 500) break
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
  throw lastError
}

export async function appendBotAgentTranscriptEntries(
  agentId: string,
  entries: readonly Record<string, unknown>[],
): Promise<number> {
  if (!entries.length) return 0
  const result = await request<{ appended?: unknown }>('appendAgentTranscriptEntries', {
    agentId,
    entries,
  }, { timeoutMs: 20_000 })
  return typeof result.appended === 'number' ? result.appended : 0
}

export async function replaceBotAgentTranscriptEntries(
  agentId: string,
  entries: readonly Record<string, unknown>[],
): Promise<number> {
  const result = await request<{ replaced?: unknown }>('replaceAgentTranscriptEntries', {
    agentId,
    entries,
  }, { timeoutMs: 30_000 })
  return typeof result.replaced === 'number' ? result.replaced : entries.length
}

export async function deleteBotAgent(agentId: string): Promise<void> {
  await request('deleteAgent', { id: agentId }, { timeoutMs: 30_000 })
}

export async function getBotAgentAvatar(agentId: string, version?: string | null): Promise<WorkHostAvatar | null> {
  const config = requiredConfig()
  const url = new URL(`${config.baseUrl}/avatars/${encodeURIComponent(agentId)}`)
  if (version) url.searchParams.set('v', version)
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${config.apiToken}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      lastError = new WorkHostError(error instanceof Error ? error.message : 'Avatar request failed', 503, 'avatar')
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 150))
        continue
      }
      throw lastError
    }
    if (response.status === 404) {
      await response.body?.cancel()
      return null
    }
    if (!response.ok) {
      await response.body?.cancel()
      lastError = new WorkHostError(`Work Host avatar rejected (${response.status})`, response.status, 'avatar')
      if (attempt === 0 && response.status >= 500) {
        await new Promise((resolve) => setTimeout(resolve, 150))
        continue
      }
      throw lastError
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    return {
      bytes,
      contentType: response.headers.get('content-type') || 'image/png',
      etag: response.headers.get('etag'),
    }
  }
  throw lastError
}

export async function getWorkHostHealth(): Promise<{ ok: boolean; pid?: number } | null> {
  const config = workHostConfig()
  if (!config) return null
  try {
    const response = await fetch(`${config.baseUrl}/health`, {
      headers: { Authorization: `Bearer ${config.apiToken}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) return { ok: false }
    const payload = await response.json().catch(() => null) as { ok?: unknown; pid?: unknown } | null
    return { ok: payload?.ok === true, ...(typeof payload?.pid === 'number' ? { pid: payload.pid } : {}) }
  } catch {
    return { ok: false }
  }
}
