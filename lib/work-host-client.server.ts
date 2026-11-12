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

export interface WorkHostGroupCreateResult extends WorkHostCreateAgentResult {
  agent: WorkHostAgent & { isGroup?: boolean; memberIds?: string[] }
}

export interface WorkHostAvatar {
  bytes: Uint8Array
  contentType: string
  etag: string | null
}

export interface WorkHostAutomationRun {
  id: string
  trigger: 'schedule' | 'manual' | 'event'
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'ok' | 'error'
  detail?: string
  event?: string
  coalescedRunIds?: string[]
}

export interface WorkHostAutomation {
  id: string
  name: string
  prompt: string
  trigger?: {
    type: 'cron'
    schedule: string
  }
  schedule: string
  triggerDescription: string
  isEnabled: boolean
  createdAt: number
  lastRunAt: number | null
  nextRunAt: number | null
  runs: WorkHostAutomationRun[]
  filePath: string
}

export interface WorkHostAutomationSpec {
  name: string
  prompt: string
  trigger: {
    type: 'cron'
    schedule: string
  }
  isEnabled?: boolean
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

export async function createBotGroup(input: {
  name: string
  description: string
  memberAgentIds: readonly string[]
  externalId?: string
}): Promise<WorkHostGroupCreateResult> {
  return await request<WorkHostGroupCreateResult>('createGroup', {
    name: input.name,
    description: input.description,
    memberAgentIds: [...input.memberAgentIds],
    ...(input.externalId ? { externalId: input.externalId } : {}),
  }, { timeoutMs: 60_000 })
}

export async function setBotGroupMembers(
  groupAgentId: string,
  memberAgentIds: readonly string[],
): Promise<(WorkHostAgent & { isGroup?: boolean; memberIds?: string[] }) | null> {
  return await request('setGroupMembers', {
    id: groupAgentId,
    memberAgentIds: [...memberAgentIds],
  }, { timeoutMs: 30_000 })
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

export async function getBotAgentAutomations(agentId: string): Promise<WorkHostAutomation[]> {
  const result = await request<unknown>('getAgentAutomations', { id: agentId }, { timeoutMs: 20_000 })
  return Array.isArray(result)
    ? result.filter((entry): entry is WorkHostAutomation => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    : []
}

export async function createBotAgentAutomation(
  agentId: string,
  spec: WorkHostAutomationSpec,
): Promise<WorkHostAutomation[]> {
  return await request<WorkHostAutomation[]>('createAgentAutomation', { id: agentId, spec }, { timeoutMs: 30_000 })
}

export async function updateBotAgentAutomation(
  agentId: string,
  automationId: string,
  spec: WorkHostAutomationSpec,
): Promise<WorkHostAutomation[]> {
  return await request<WorkHostAutomation[]>('updateAgentAutomation', {
    id: agentId,
    automationId,
    spec,
  }, { timeoutMs: 30_000 })
}

export async function setBotAgentAutomationEnabled(
  agentId: string,
  automationId: string,
  isEnabled: boolean,
): Promise<WorkHostAutomation[]> {
  return await request<WorkHostAutomation[]>('setAgentAutomationEnabled', {
    id: agentId,
    automationId,
    isEnabled,
  }, { timeoutMs: 30_000 })
}

export async function deleteBotAgentAutomation(
  agentId: string,
  automationId: string,
): Promise<WorkHostAutomation[]> {
  return await request<WorkHostAutomation[]>('deleteAgentAutomation', {
    id: agentId,
    automationId,
  }, { timeoutMs: 30_000 })
}

export async function runBotAgentAutomationNow(
  agentId: string,
  automationId: string,
): Promise<void> {
  await request('runAgentAutomationNow', { id: agentId, automationId }, { timeoutMs: 120_000 })
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

export interface WorkHostRuntimeConfiguration {
  providerId: string
  modelId: string
  apiKey: string
  baseUrl: string
  revision: string
}

export interface WorkHostBotBox {
  boxKey: string
  sandboxId: string | null
  desktopUrl: string
  vncUrl: string
}

export interface WorkHostBotBoxStatus {
  state: 'absent' | 'running'
  boxKey?: string
  sandboxId?: string | null
  desktopUrl?: string
  vncUrl?: string
}

/**
 * Ensure the Bot's one OpenSandbox inside the Project VM. The Work-host owns
 * the binding and keeps the worker credentials; only the desktop URL comes
 * back to the BFF.
 */
export async function ensureBotBox(input: {
  agentId: string
  botId: string
  projectId: string
  userId: string
  workspaceId: string
  runtimeConfiguration: WorkHostRuntimeConfiguration
}): Promise<WorkHostBotBox> {
  const result = await request<WorkHostBotBox>('ensureBotBox', input, { timeoutMs: 300_000 })
  if (typeof result?.desktopUrl !== 'string' || typeof result?.boxKey !== 'string') {
    throw new WorkHostError('Work Host returned an incomplete Bot box', 502, 'ensureBotBox')
  }
  return result
}

export async function getBotBoxStatus(agentId: string): Promise<WorkHostBotBoxStatus> {
  const result = await request<WorkHostBotBoxStatus>('getBotBoxStatus', { agentId }, { timeoutMs: 20_000 })
  return result?.state === 'running' ? result : { state: 'absent' }
}

export async function releaseBotBox(agentId: string): Promise<void> {
  await request('releaseBotBox', { agentId }, { timeoutMs: 30_000 })
}

export async function respondBotExtensionUi(input: {
  agentId: string
  id: string
  confirmed?: boolean
  value?: string
  cancelled?: true
}): Promise<void> {
  await request('respondBotExtensionUi', input, { timeoutMs: 15_000 })
}

/**
 * Accept a Bot turn and stream its Work-host frames. The response is NDJSON;
 * the caller owns the reader. A client disconnect stops the projection, not
 * the durable turn.
 */
export async function sendBotPromptStream(input: {
  agentId: string
  prompt: string
  clientNonce?: string
}): Promise<Response> {
  const config = requiredConfig()
  let response: Response
  try {
    response = await fetch(`${config.baseUrl}/api/bot/sendPrompt`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson',
      },
      body: JSON.stringify(input),
      cache: 'no-store',
    })
  } catch (error) {
    throw new WorkHostError(
      error instanceof Error ? error.message : 'Work Host Bot prompt failed',
      503,
      'sendBotPrompt',
    )
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as unknown
    const detail = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error?: unknown }).error ?? '')
      : ''
    await response.body?.cancel().catch(() => undefined)
    throw new WorkHostError(detail || `Work Host rejected sendBotPrompt`, response.status, 'sendBotPrompt')
  }
  return response
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
