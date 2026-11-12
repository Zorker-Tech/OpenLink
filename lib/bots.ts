import 'server-only'

import { randomUUID } from 'node:crypto'
import { resolveConfiguredModelSelection } from '@/lib/ai-provider-configurations.server'
import {
  BotTranscriptReplaceLimitError,
  WORK_HOST_TRANSCRIPT_REPLACE_LIMIT,
  chunkWorkHostEntries,
  normalizeWorkHostTranscript,
  planBotTranscriptRecovery,
  previewFromEntries,
  toWorkHostEntry,
  transcriptFromAgentEvents,
  type BotTranscriptEntry,
} from '@/lib/bot-transcript'
import { releaseBotRuntime } from '@/lib/bot-runtime.server'
import {
  decideBotProjectionRecovery,
  isBotProjectionSession,
  type BotProjectionProject,
  type BotProjectionSession,
} from '@/lib/bot-runtime-projection'
import type { BotDetail, BotGroupMemberSummary, BotRoutine, BotRuntimeStatus, BotSummary } from '@/lib/bot-types'
import { pendingBotConfirmations, type BotConfirmationRequest } from '@/lib/bot-confirmations'
import { generateChatSessionId } from '@/lib/chat-sessions'
import { listPersistedChatEvents, listPersistedConfirmationEvents } from '@/lib/chat-session-persistence.server'
import { ensureDraftProject } from '@/lib/projects'
import { getAccessibleWorkspace, getAccessibleWorkspaceById, type OpenLinkWorkspace } from '@/lib/workspaces'
import {
  appendBotAgentTranscriptEntries,
  createBotAgent,
  createBotAgentAutomation,
  deleteBotAgent,
  deleteBotAgentAutomation,
  getBotAgentAutomations,
  getBotAgentAvatar,
  getBotAgentTranscript,
  isMissingWorkHostAgentError,
  replaceBotAgentTranscriptEntries,
  runBotAgentAutomationNow,
  setBotAgentAvatar,
  setBotAgentAutomationEnabled,
  updateBotAgent,
  updateBotAgentAutomation,
  type WorkHostAvatar,
  type WorkHostAutomation,
  type WorkHostAutomationSpec,
} from '@/lib/work-host-client.server'
import { createClient } from '@/utils/supabase/server'

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>

export type { BotDetail, BotSummary } from '@/lib/bot-types'

interface BotRow {
  id: string
  user_id: string
  workspace_id: string
  project_id: string | null
  runtime_session_id: string | null
  runtime_status: BotRuntimeStatus
  runtime_ready_at: string | null
  runtime_last_error: string | null
  runtime_checked_at: string | null
  work_agent_id: string
  name: string
  description: string
  avatar_shape: string
  avatar_color: string
  kind: 'bot' | 'group'
  member_ids: string[] | null
  provider_id: string | null
  model_id: string | null
  last_entry_text: string
  last_activity_at: string
  last_viewed_at: string
  created_at: string
  updated_at: string
}

const BOT_SELECT = 'id, user_id, workspace_id, project_id, runtime_session_id, runtime_status, runtime_ready_at, runtime_last_error, runtime_checked_at, work_agent_id, name, description, avatar_shape, avatar_color, kind, member_ids, provider_id, model_id, last_entry_text, last_activity_at, last_viewed_at, created_at, updated_at'
const SAFE_BOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SAFE_AVATAR_ID = /^[a-z0-9-]{1,32}$/
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/
const BOT_AGENT_RECOVERY_LOCKS = new Map<string, Promise<unknown>>()
const BOT_PROJECTION_RECOVERY_LOCKS = new Map<string, Promise<unknown>>()

export class BotInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BotInputError'
  }
}

export function isBotId(value: string): boolean {
  return SAFE_BOT_ID.test(value)
}

async function withBotProjectionLock<T>(botId: string, work: () => Promise<T>): Promise<T> {
  const previous = BOT_PROJECTION_RECOVERY_LOCKS.get(botId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.then(() => current)
  BOT_PROJECTION_RECOVERY_LOCKS.set(botId, queued)
  await previous.catch(() => undefined)
  try {
    return await work()
  } finally {
    release()
    if (BOT_PROJECTION_RECOVERY_LOCKS.get(botId) === queued) BOT_PROJECTION_RECOVERY_LOCKS.delete(botId)
  }
}

async function readBotProjection(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
): Promise<{ session: BotProjectionSession | null; project: BotProjectionProject | null; projectReadFailed: boolean }> {
  const [sessionResult, projectResult] = await Promise.all([
    bot.runtimeSessionId
      ? supabase
        .schema('openlink')
        .from('chat_sessions')
        .select('id, user_id, workspace_id, project_id, surface')
        .eq('id', bot.runtimeSessionId)
        .eq('user_id', userId)
        .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    bot.projectId
      ? supabase
        .schema('openlink')
        .from('projects')
        .select('id, workspace_id')
        .eq('id', bot.projectId)
        .eq('workspace_id', bot.workspaceId)
        .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])
  if (sessionResult.error) throw sessionResult.error
  if (projectResult.error) {
    console.error(`[openlink-bots] project projection read failed for ${bot.id}`, projectResult.error)
  }
  return {
    session: sessionResult.data as BotProjectionSession | null,
    project: projectResult.error ? null : projectResult.data as BotProjectionProject | null,
    projectReadFailed: Boolean(projectResult.error),
  }
}

async function repairBotSessionProject(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
  projectId: string,
): Promise<boolean> {
  if (!bot.runtimeSessionId) return false
  const { data, error } = await supabase
    .schema('openlink')
    .from('chat_sessions')
    .update({
      project_id: projectId,
      title: bot.name,
      provider_id: bot.providerId,
      model_id: bot.modelId,
      agent: 'pi',
      access_mode: 'restricted',
      surface: 'bot',
      updated_at: new Date().toISOString(),
    })
    .eq('id', bot.runtimeSessionId)
    .eq('user_id', userId)
    .eq('workspace_id', bot.workspaceId)
    .eq('surface', 'bot')
    .select('id')
    .maybeSingle()
  if (error) throw error
  return Boolean(data)
}

/**
 * Resolve the Bot's hidden execution session without repairing or creating
 * anything. Profile updates and teardown use this read-only guard so they can
 * never mutate an ordinary Code-mode session that happens to share the id.
 */
async function readOwnedBotRuntimeSession(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
): Promise<BotProjectionSession | null> {
  if (!bot.runtimeSessionId) return null
  const { data, error } = await supabase
    .schema('openlink')
    .from('chat_sessions')
    .select('id, user_id, workspace_id, project_id, surface')
    .eq('id', bot.runtimeSessionId)
    .eq('user_id', userId)
    .eq('workspace_id', bot.workspaceId)
    .eq('surface', 'bot')
    .maybeSingle()
  if (error) throw error
  return isBotProjectionSession(bot, data as BotProjectionSession | null)
    ? data as BotProjectionSession
    : null
}

async function createBotRuntimeSession(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
  projectId: string,
): Promise<string> {
  const preferredId = bot.runtimeSessionId
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const runtimeSessionId = attempt === 0 && preferredId ? preferredId : generateChatSessionId()
    const { error } = await supabase
      .schema('openlink')
      .from('chat_sessions')
      .insert({
        id: runtimeSessionId,
        user_id: userId,
        workspace_id: bot.workspaceId,
        project_id: projectId,
        provider_id: bot.providerId,
        model_id: bot.modelId,
        agent: 'pi',
        title: bot.name,
        initial_prompt: '',
        access_mode: 'restricted',
        surface: 'bot',
      })
    if (!error) return runtimeSessionId
    if (error.code !== '23505') throw error
  }
  throw new Error('BOT_RUNTIME_SESSION_ID_CONFLICT')
}

/**
 * Rebuild a Bot's lost runtime projection from the durable Bot identity.
 *
 * `openlink.bots` owns identity, while the hidden Bot session and Project are
 * replaceable projections. Recovery never adopts a Code-mode session and never
 * mutates ordinary Code sessions: it either repairs the hidden Bot session in
 * place or creates a fresh `surface = 'bot'` session, then atomically updates
 * the Bot mapping.
 */
export async function ensureBotRuntimeProjection(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
): Promise<BotSummary> {
  return await withBotProjectionLock(bot.id, async () => {
    const latest = await getBot(supabase, userId, bot.id)
    if (!latest) throw new BotInputError('BOT_NOT_FOUND')

    const observation = await readBotProjection(supabase, userId, latest)
    // A transient Project read failure is not evidence that the Project was
    // lost. Do not replace a healthy Project because a restore is still
    // settling; the caller retries the same idempotent operation.
    if (observation.projectReadFailed) throw new Error('BOT_PROJECTION_READ_FAILED')
    const decision = decideBotProjectionRecovery(latest, observation)
    if (decision.action === 'reuse') return latest

    let projectId = latest.projectId
    if (decision.recreateProject) {
      const workspace = await getAccessibleWorkspaceById(supabase, latest.workspaceId)
      if (!workspace || workspace.id !== latest.workspaceId) throw new BotInputError('BOT_WORKSPACE_NOT_FOUND')
      const project = await ensureDraftProject(supabase, userId, workspace)
      projectId = project.id
    }
    if (!projectId) throw new BotInputError('BOT_PROJECT_NOT_READY')

    let createdSessionId: string | null = null
    let runtimeSessionId = latest.runtimeSessionId
    if (decision.recreateSession) {
      runtimeSessionId = await createBotRuntimeSession(supabase, userId, latest, projectId)
      createdSessionId = runtimeSessionId
    } else if (decision.repairSession) {
      const repaired = await repairBotSessionProject(supabase, userId, latest, projectId)
      if (!repaired) {
        // The session disappeared or changed ownership between observation and
        // repair. Never fall back to updating it in place; create a fresh
        // hidden Bot session instead.
        runtimeSessionId = await createBotRuntimeSession(supabase, userId, latest, projectId)
        createdSessionId = runtimeSessionId
      }
    }
    if (!runtimeSessionId) throw new BotInputError('BOT_RUNTIME_NOT_READY')

    const now = new Date().toISOString()
    let update = supabase
      .schema('openlink')
      .from('bots')
      .update({
        project_id: projectId,
        runtime_session_id: runtimeSessionId,
        runtime_status: 'pending',
        runtime_ready_at: null,
        runtime_last_error: null,
        runtime_checked_at: now,
        updated_at: now,
      })
      .eq('id', latest.id)
      .eq('user_id', userId)
    update = latest.projectId ? update.eq('project_id', latest.projectId) : update.is('project_id', null)
    update = latest.runtimeSessionId ? update.eq('runtime_session_id', latest.runtimeSessionId) : update.is('runtime_session_id', null)
    const { data, error } = await update.select(BOT_SELECT).maybeSingle()
    if (error) {
      if (createdSessionId) {
        await supabase
          .schema('openlink')
          .from('chat_sessions')
          .delete()
          .eq('id', createdSessionId)
          .eq('user_id', userId)
          .eq('surface', 'bot')
      }
      throw error
    }
    if (!data) {
      if (createdSessionId) {
        await supabase
          .schema('openlink')
          .from('chat_sessions')
          .delete()
          .eq('id', createdSessionId)
          .eq('user_id', userId)
          .eq('surface', 'bot')
      }
      const raced = await getBot(supabase, userId, latest.id)
      if (!raced) throw new BotInputError('BOT_NOT_FOUND')
      return raced
    }
    console.info(`[openlink-bots] recovered ${decision.action} projection for ${latest.id}`)
    return summary(data as BotRow)
  })
}

/**
 * Recreate only the Work-host agent projection after its local store is lost.
 * The `openlink.bots` row is the durable identity; the hidden chat session is
 * the durable execution identity. Neither is recreated here.
 */
async function recreateBotAgent(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
): Promise<BotSummary> {
  const previous = BOT_AGENT_RECOVERY_LOCKS.get(bot.id) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.then(() => current)
  BOT_AGENT_RECOVERY_LOCKS.set(bot.id, queued)
  await previous.catch(() => undefined)
  try {
    // Another request may have repaired the agent while this one waited.
    const latest = await getBot(supabase, userId, bot.id)
    if (!latest) throw new Error('BOT_NOT_FOUND')
    if (latest.workAgentId !== bot.workAgentId) return latest

    const created = await createBotAgent({
      name: latest.name,
      description: latest.description,
      avatarShape: latest.avatarShape,
      avatarColor: latest.avatarColor,
    })
    const { data, error } = await supabase
      .schema('openlink')
      .from('bots')
      .update({
        work_agent_id: created.agent.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', latest.id)
      .eq('user_id', userId)
      .eq('work_agent_id', latest.workAgentId)
      .select(BOT_SELECT)
      .maybeSingle()
    if (error) {
      await deleteBotAgent(created.agent.id).catch(() => undefined)
      throw error
    }
    if (!data) {
      await deleteBotAgent(created.agent.id).catch(() => undefined)
      const raced = await getBot(supabase, userId, bot.id)
      if (!raced) throw new Error('BOT_NOT_FOUND')
      return raced
    }
    return summary(data as BotRow)
  } finally {
    release()
    if (BOT_AGENT_RECOVERY_LOCKS.get(bot.id) === queued) BOT_AGENT_RECOVERY_LOCKS.delete(bot.id)
  }
}

async function readBotTranscript(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
): Promise<{ bot: BotSummary; entries: Record<string, unknown>[] }> {
  try {
    return { bot, entries: await getBotAgentTranscript(bot.workAgentId) }
  } catch (error) {
    if (!isMissingWorkHostAgentError(error)) throw error
    const recovered = await recreateBotAgent(supabase, userId, bot)
    return { bot: recovered, entries: await getBotAgentTranscript(recovered.workAgentId) }
  }
}

async function appendToWorkHost(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
  entries: readonly Record<string, unknown>[],
): Promise<BotSummary> {
  const chunks = chunkWorkHostEntries(entries)
  if (!chunks.length) return bot

  const appendAll = async (agentId: string) => {
    for (const chunk of chunks) {
      await appendBotAgentTranscriptEntries(agentId, chunk)
    }
  }

  try {
    await appendAll(bot.workAgentId)
    return bot
  } catch (error) {
    if (!isMissingWorkHostAgentError(error)) throw error
    const recovered = await recreateBotAgent(supabase, userId, bot)
    // Work-host inserts by entry id with INSERT OR IGNORE. Replaying every
    // chunk is therefore safe even when a later chunk discovered the lost
    // agent after earlier chunks had already been written.
    await appendAll(recovered.workAgentId)
    return recovered
  }
}

async function replaceWorkHostTranscript(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
  entries: readonly Record<string, unknown>[],
): Promise<BotSummary> {
  if (entries.length > WORK_HOST_TRANSCRIPT_REPLACE_LIMIT) {
    throw new BotTranscriptReplaceLimitError(entries.length)
  }

  try {
    await replaceBotAgentTranscriptEntries(bot.workAgentId, entries)
    return bot
  } catch (error) {
    if (!isMissingWorkHostAgentError(error)) throw error
    const recovered = await recreateBotAgent(supabase, userId, bot)
    await replaceBotAgentTranscriptEntries(recovered.workAgentId, entries)
    return recovered
  }
}

function routineFromWorkHost(automation: WorkHostAutomation): BotRoutine | null {
  if (typeof automation.id !== 'string' || typeof automation.name !== 'string') return null
  return {
    id: automation.id,
    name: automation.name,
    prompt: typeof automation.prompt === 'string' ? automation.prompt : '',
    triggerDescription: typeof automation.triggerDescription === 'string' ? automation.triggerDescription : '',
    schedule: typeof automation.schedule === 'string' ? automation.schedule : '',
    isEnabled: automation.isEnabled === true,
    nextRunAt: typeof automation.nextRunAt === 'number' ? automation.nextRunAt : null,
    lastRunAt: typeof automation.lastRunAt === 'number' ? automation.lastRunAt : null,
  }
}

function routinesFromWorkHost(automations: readonly WorkHostAutomation[]): BotRoutine[] {
  return automations.flatMap((automation) => {
    const routine = routineFromWorkHost(automation)
    return routine ? [routine] : []
  })
}

async function readBotAutomations(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
): Promise<{ bot: BotSummary; routines: BotRoutine[] }> {
  try {
    return { bot, routines: routinesFromWorkHost(await getBotAgentAutomations(bot.workAgentId)) }
  } catch (error) {
    if (!isMissingWorkHostAgentError(error)) throw error
    const recovered = await recreateBotAgent(supabase, userId, bot)
    return { bot: recovered, routines: routinesFromWorkHost(await getBotAgentAutomations(recovered.workAgentId)) }
  }
}

export async function listBotRoutines(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
): Promise<BotRoutine[]> {
  return (await readBotAutomations(supabase, userId, bot)).routines
}

export async function createBotRoutine(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
  spec: WorkHostAutomationSpec,
): Promise<BotRoutine[]> {
  try {
    return routinesFromWorkHost(await createBotAgentAutomation(bot.workAgentId, spec))
  } catch (error) {
    if (!isMissingWorkHostAgentError(error)) throw error
    const recovered = await recreateBotAgent(supabase, userId, bot)
    return routinesFromWorkHost(await createBotAgentAutomation(recovered.workAgentId, spec))
  }
}

export async function updateBotRoutine(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
  automationId: string,
  spec: WorkHostAutomationSpec,
): Promise<BotRoutine[]> {
  try {
    return routinesFromWorkHost(await updateBotAgentAutomation(bot.workAgentId, automationId, spec))
  } catch (error) {
    if (!isMissingWorkHostAgentError(error)) throw error
    const recovered = await recreateBotAgent(supabase, userId, bot)
    return routinesFromWorkHost(await updateBotAgentAutomation(recovered.workAgentId, automationId, spec))
  }
}

export async function setBotRoutineEnabled(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
  automationId: string,
  isEnabled: boolean,
): Promise<BotRoutine[]> {
  try {
    return routinesFromWorkHost(await setBotAgentAutomationEnabled(bot.workAgentId, automationId, isEnabled))
  } catch (error) {
    if (!isMissingWorkHostAgentError(error)) throw error
    const recovered = await recreateBotAgent(supabase, userId, bot)
    return routinesFromWorkHost(await setBotAgentAutomationEnabled(recovered.workAgentId, automationId, isEnabled))
  }
}

export async function deleteBotRoutine(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
  automationId: string,
): Promise<BotRoutine[]> {
  try {
    return routinesFromWorkHost(await deleteBotAgentAutomation(bot.workAgentId, automationId))
  } catch (error) {
    if (!isMissingWorkHostAgentError(error)) throw error
    const recovered = await recreateBotAgent(supabase, userId, bot)
    return routinesFromWorkHost(await deleteBotAgentAutomation(recovered.workAgentId, automationId))
  }
}

export async function runBotRoutineNow(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
  automationId: string,
): Promise<void> {
  try {
    await runBotAgentAutomationNow(bot.workAgentId, automationId)
  } catch (error) {
    if (!isMissingWorkHostAgentError(error)) throw error
    const recovered = await recreateBotAgent(supabase, userId, bot)
    await runBotAgentAutomationNow(recovered.workAgentId, automationId)
  }
}

function summary(row: BotRow, members: BotGroupMemberSummary[] = []): BotSummary {
  return {
    id: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    runtimeSessionId: row.runtime_session_id,
    runtimeStatus: row.runtime_status,
    runtimeReadyAt: row.runtime_ready_at,
    runtimeLastError: row.runtime_last_error,
    runtimeCheckedAt: row.runtime_checked_at,
    workAgentId: row.work_agent_id,
    name: row.name,
    description: row.description,
    avatarShape: row.avatar_shape,
    avatarColor: row.avatar_color,
    providerId: row.provider_id,
    modelId: row.model_id,
    lastEntryText: row.last_entry_text,
    lastActivityAt: row.last_activity_at,
    lastViewedAt: row.last_viewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    unread: Date.parse(row.last_activity_at) > Date.parse(row.last_viewed_at),
    kind: row.kind,
    memberIds: row.member_ids ?? [],
    members: row.kind === 'group' ? members : [],
  }
}

interface BotGroupMemberRow {
  id: string
  workspace_id: string
  kind: 'bot' | 'group'
  name: string
  avatar_shape: string
  avatar_color: string
  updated_at: string
}

function groupMemberSummary(row: BotGroupMemberRow): BotGroupMemberSummary {
  return {
    id: row.id,
    name: row.name,
    avatarShape: row.avatar_shape,
    avatarColor: row.avatar_color,
    updatedAt: row.updated_at,
  }
}

/**
 * Load every member of the given groups in one query, preserving the stored
 * member order. A group may only contain ordinary Bots from the same
 * workspace, so a stale or tampered row cannot leak another tenant's Bot or
 * nest one group inside another.
 */
async function readGroupMembers(
  supabase: ServerSupabaseClient,
  userId: string,
  rows: readonly BotRow[],
): Promise<Map<string, BotGroupMemberSummary[]>> {
  const groupRows = rows.filter((row) => row.kind === 'group')
  const memberIds = [...new Set(groupRows.flatMap((row) => row.member_ids ?? []))]
  if (!memberIds.length) return new Map()
  const { data, error } = await supabase
    .schema('openlink')
    .from('bots')
    .select('id, workspace_id, kind, name, avatar_shape, avatar_color, updated_at')
    .eq('user_id', userId)
    .eq('workspace_id', rows.find((row) => row.kind === 'group')?.workspace_id ?? '')
    .eq('kind', 'bot')
    .in('id', memberIds)
  if (error) throw error
  const byId = new Map(
    ((data ?? []) as BotGroupMemberRow[])
      .filter((row) => row.kind === 'bot' && row.workspace_id === groupRows[0]?.workspace_id)
      .map((row) => [row.id, groupMemberSummary(row)]),
  )
  return new Map(groupRows.map((row) => [
    row.id,
    (row.member_ids ?? []).flatMap((id) => {
      const member = byId.get(id)
      return member ? [member] : []
    }),
  ]))
}

function normalizeName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  if (name.length < 1 || name.length > 64) throw new BotInputError('BOT_NAME_INVALID')
  return name
}

function normalizeDescription(value: unknown): string {
  const description = typeof value === 'string' ? value.trim() : ''
  if (description.length > 2000) throw new BotInputError('BOT_DESCRIPTION_INVALID')
  return description
}

function normalizeAvatar(value: unknown, fallback: string): string {
  const candidate = typeof value === 'string' ? value.trim() : ''
  if (!SAFE_AVATAR_ID.test(candidate)) {
    if (fallback) return fallback
    throw new BotInputError('BOT_AVATAR_INVALID')
  }
  return candidate
}

function normalizePng(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 8_000_000) throw new BotInputError('BOT_AVATAR_TOO_LARGE')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new BotInputError('BOT_AVATAR_INVALID')
  let bytes: Buffer
  try {
    bytes = Buffer.from(value, 'base64')
  } catch {
    throw new BotInputError('BOT_AVATAR_INVALID')
  }
  if (bytes.length === 0 || bytes.length > 4 * 1024 * 1024) throw new BotInputError('BOT_AVATAR_TOO_LARGE')
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (!signature.every((byte, index) => bytes[index] === byte)) throw new BotInputError('BOT_AVATAR_INVALID')
  return value
}

function normalizeModel(value: unknown): { providerId: string; modelId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BotInputError('BOT_MODEL_REQUIRED')
  const record = value as Record<string, unknown>
  const providerId = typeof record.providerId === 'string' ? record.providerId.trim() : ''
  const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : ''
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(providerId) || !SAFE_MODEL_ID.test(modelId)) {
    throw new BotInputError('BOT_MODEL_REQUIRED')
  }
  return { providerId, modelId }
}

export async function listBots(
  supabase: ServerSupabaseClient,
  userId: string,
  workspaceId: string,
): Promise<BotSummary[]> {
  const { data, error } = await supabase
    .schema('openlink')
    .from('bots')
    .select(BOT_SELECT)
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .order('updated_at', { ascending: false })
  if (error) throw error
  const rows = (data ?? []) as BotRow[]
  const members = await readGroupMembers(supabase, userId, rows)
  return rows.map((row) => summary(row, members.get(row.id)))
}

export async function getBot(
  supabase: ServerSupabaseClient,
  userId: string,
  botId: string,
): Promise<BotSummary | null> {
  if (!isBotId(botId)) return null
  const { data, error } = await supabase
    .schema('openlink')
    .from('bots')
    .select(BOT_SELECT)
    .eq('id', botId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const row = data as BotRow
  const members = await readGroupMembers(supabase, userId, [row])
  return summary(row, members.get(row.id))
}

/**
 * Verify that a hidden execution session belongs to this exact Bot.
 *
 * The Bot row is the authority for the mapping: a session is Bot-authorized
 * only when its id matches `runtime_session_id`, it is tagged `surface = 'bot'`,
 * and both the Bot and session agree on user, workspace, and Project. This
 * deliberately rejects Code-mode sessions and mismatched mappings so a shared
 * endpoint cannot turn a session id into an authorization capability.
 */
export function isBotRuntimeSessionForBot(
  bot: BotSummary,
  session: {
    id: string
    user_id: string
    workspace_id: string
    project_id: string
    surface: string
  } | null,
): boolean {
  return Boolean(
    bot.runtimeSessionId
      && session
      && session.id === bot.runtimeSessionId
      && session.surface === 'bot'
      && session.user_id === bot.userId
      && session.workspace_id === bot.workspaceId
      && session.project_id === bot.projectId,
  )
}

export async function getBotInWorkspace(
  supabase: ServerSupabaseClient,
  userId: string,
  botId: string,
  workspaceId: string,
): Promise<BotSummary | null> {
  if (!isBotId(botId)) return null
  const { data, error } = await supabase
    .schema('openlink')
    .from('bots')
    .select(BOT_SELECT)
    .eq('id', botId)
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const row = data as BotRow
  const members = await readGroupMembers(supabase, userId, [row])
  return summary(row, members.get(row.id))
}

export async function getBotDetail(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
): Promise<BotDetail> {
  let transcript: BotTranscriptEntry[] = []
  let authoritativeBot = await ensureBotRuntimeProjection(supabase, userId, bot)
  let readError: unknown = null
  let pendingConfirmations: BotConfirmationRequest[] = []
  let routines: BotRoutine[] = []
  try {
    const read = await readBotTranscript(supabase, userId, authoritativeBot)
    authoritativeBot = read.bot
    transcript = normalizeWorkHostTranscript(read.entries)
  } catch (error) {
    readError = error
    console.error(`[openlink-bots] transcript read failed for ${bot.id}`, error)
  }
  if (authoritativeBot.runtimeSessionId) {
    try {
      pendingConfirmations = pendingBotConfirmations(
        await listPersistedConfirmationEvents(supabase, userId, authoritativeBot.runtimeSessionId),
      )
    } catch (error) {
      console.error(`[openlink-bots] confirmation read failed for ${bot.id}`, error)
    }
  }
  // Work-host is the transcript authority, but its state is a local store. The
  // durable Code-mode event log is the recovery source. Reconcile it on every
  // read: a lost store rebuilds from scratch, a lost tail is appended, and an
  // ordering gap is replaced atomically. Local-only entries are retained.
  if (authoritativeBot.runtimeSessionId) {
    try {
      const events = await listPersistedChatEvents(supabase, userId, authoritativeBot.runtimeSessionId)
      const recovered = transcriptFromAgentEvents(events)
      const plan = planBotTranscriptRecovery(transcript, recovered)
      transcript = plan.transcript
      if (plan.action === 'replace' && plan.replaceLimitError) {
        console.error(
          `[openlink-bots] transcript recovery replacement exceeds Work-host limit for ${bot.id}; keeping the complete durable transcript`,
          plan.replaceLimitError,
        )
      } else if (plan.action === 'replace') {
        await replaceWorkHostTranscript(
          supabase,
          userId,
          authoritativeBot,
          plan.transcript.map(toWorkHostEntry),
        ).then((nextBot) => {
          authoritativeBot = nextBot
        }).catch((error) => {
          console.error(`[openlink-bots] transcript recovery mirror failed for ${bot.id}`, error)
        })
      } else if (plan.action === 'append') {
        await appendToWorkHost(
          supabase,
          userId,
          authoritativeBot,
          plan.missing.map(toWorkHostEntry),
        ).then((nextBot) => {
          authoritativeBot = nextBot
        }).catch((error) => {
          console.error(`[openlink-bots] transcript recovery mirror failed for ${bot.id}`, error)
        })
      }
    } catch (error) {
      console.error(`[openlink-bots] transcript recovery failed for ${bot.id}`, error)
    }
  }
  if (readError && !transcript.length) throw readError
  try {
    const read = await readBotAutomations(supabase, userId, authoritativeBot)
    authoritativeBot = read.bot
    routines = read.routines
  } catch (error) {
    console.error(`[openlink-bots] routines read failed for ${bot.id}`, error)
  }
  return {
    ...authoritativeBot,
    transcript,
    runtimeReady: authoritativeBot.runtimeStatus === 'ready' && Boolean(authoritativeBot.runtimeSessionId),
    pendingConfirmations,
    routines,
  }
}

export async function updateBotRuntimeState(
  supabase: ServerSupabaseClient,
  userId: string,
  botId: string,
  state: {
    status: BotRuntimeStatus
    error?: string | null
  },
): Promise<void> {
  if (!isBotId(botId)) throw new BotInputError('BOT_NOT_FOUND')
  const now = new Date().toISOString()
  const { error } = await supabase
    .schema('openlink')
    .from('bots')
    .update({
      runtime_status: state.status,
      runtime_last_error: state.status === 'failed' ? (state.error ?? 'BOT_RUNTIME_UNAVAILABLE').slice(0, 2000) : null,
      runtime_checked_at: now,
      ...(state.status === 'ready' ? { runtime_ready_at: now } : {}),
      updated_at: now,
    })
    .eq('id', botId)
    .eq('user_id', userId)
  if (error) throw error
}

export async function createBot(
  supabase: ServerSupabaseClient,
  userId: string,
  input: {
    workspaceSlug: string
    name: unknown
    description?: unknown
    avatarShape?: unknown
    avatarColor?: unknown
    avatarPngBase64?: unknown
    model: unknown
  },
): Promise<BotSummary> {
  const workspace = await getAccessibleWorkspace(supabase, input.workspaceSlug)
  if (!workspace) throw new BotInputError('BOT_WORKSPACE_NOT_FOUND')
  const name = normalizeName(input.name)
  const description = normalizeDescription(input.description)
  const avatarShape = normalizeAvatar(input.avatarShape, 'blob')
  const avatarColor = normalizeAvatar(input.avatarColor, 'orange')
  const avatarPngBase64 = normalizePng(input.avatarPngBase64)
  const requestedModel = normalizeModel(input.model)
  const selectedModel = await resolveConfiguredModelSelection(supabase, userId, requestedModel)
  if (!selectedModel) throw new BotInputError('BOT_MODEL_REQUIRED')
  const project = await ensureDraftProject(supabase, userId, workspace)
  let createdAgentId: string | null = null
  let createdSessionId: string | null = null
  try {
    const created = await createBotAgent({
      name,
      description,
      avatarShape,
      avatarColor,
    })
    createdAgentId = created.agent.id
    if (avatarPngBase64) await setBotAgentAvatar(created.agent.id, avatarPngBase64)
    const runtimeSessionId = generateChatSessionId()
    const { error: sessionError } = await supabase
      .schema('openlink')
      .from('chat_sessions')
      .insert({
        id: runtimeSessionId,
        user_id: userId,
        workspace_id: workspace.id,
        project_id: project.id,
        provider_id: selectedModel.providerId,
        model_id: selectedModel.modelId,
        agent: 'pi',
        title: name,
        initial_prompt: '',
        access_mode: 'restricted',
        surface: 'bot',
      })
    if (sessionError) throw sessionError
    createdSessionId = runtimeSessionId
    const { data, error } = await supabase
      .schema('openlink')
      .from('bots')
      .insert({
        user_id: userId,
        workspace_id: workspace.id,
        project_id: project.id,
        runtime_session_id: runtimeSessionId,
        runtime_status: 'pending',
        work_agent_id: created.agent.id,
        name,
        description,
        avatar_shape: avatarShape,
        avatar_color: avatarColor,
        provider_id: selectedModel.providerId,
        model_id: selectedModel.modelId,
        last_entry_text: '',
        last_activity_at: new Date().toISOString(),
        last_viewed_at: new Date().toISOString(),
      })
      .select(BOT_SELECT)
      .single()
    if (error) throw error
    return summary(data as BotRow)
  } catch (error) {
    if (createdSessionId) {
      await supabase
        .schema('openlink')
        .from('chat_sessions')
        .delete()
        .eq('id', createdSessionId)
        .eq('user_id', userId)
        .eq('workspace_id', workspace.id)
        .eq('surface', 'bot')
    }
    if (createdAgentId) await deleteBotAgent(createdAgentId).catch(() => undefined)
    throw error
  }
}

export async function updateBot(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
  input: {
    name?: unknown
    description?: unknown
    avatarShape?: unknown
    avatarColor?: unknown
    avatarPngBase64?: unknown
    model?: unknown
  },
): Promise<BotSummary> {
  const name = input.name === undefined ? bot.name : normalizeName(input.name)
  const description = input.description === undefined ? bot.description : normalizeDescription(input.description)
  const avatarShape = input.avatarShape === undefined ? bot.avatarShape : normalizeAvatar(input.avatarShape, bot.avatarShape)
  const avatarColor = input.avatarColor === undefined ? bot.avatarColor : normalizeAvatar(input.avatarColor, bot.avatarColor)
  const avatarPngBase64 = normalizePng(input.avatarPngBase64)
  const requestedModel = input.model === undefined
    ? (bot.providerId && bot.modelId ? { providerId: bot.providerId, modelId: bot.modelId } : null)
    : normalizeModel(input.model)
  if (!requestedModel) throw new BotInputError('BOT_MODEL_REQUIRED')
  const selectedModel = await resolveConfiguredModelSelection(supabase, userId, requestedModel)
  if (!selectedModel) throw new BotInputError('BOT_MODEL_REQUIRED')
  let runtimeSession: BotProjectionSession | null = null
  try {
    runtimeSession = await readOwnedBotRuntimeSession(supabase, userId, bot)
  } catch (error) {
    // The Bot profile is durable application state and does not depend on the
    // runtime projection. Leave the hidden session untouched when its
    // ownership cannot be verified; the next detail/prompt read repairs it.
    console.error(`[openlink-bots] runtime session ownership check failed for ${bot.id}`, error)
  }
  let agentId = bot.workAgentId
  try {
    await updateBotAgent({
      id: agentId,
      name,
      description,
      avatarShape,
      avatarColor,
    })
  } catch (error) {
    if (!isMissingWorkHostAgentError(error)) throw error
    const recovered = await recreateBotAgent(supabase, userId, bot)
    agentId = recovered.workAgentId
    await updateBotAgent({
      id: agentId,
      name,
      description,
      avatarShape,
      avatarColor,
    })
  }
  if (avatarPngBase64) await setBotAgentAvatar(agentId, avatarPngBase64)
  const { data, error } = await supabase
    .schema('openlink')
    .from('bots')
    .update({
      ...(agentId === bot.workAgentId ? {} : { work_agent_id: agentId }),
      name,
      description,
      avatar_shape: avatarShape,
      avatar_color: avatarColor,
      provider_id: selectedModel.providerId,
      model_id: selectedModel.modelId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', bot.id)
    .eq('user_id', userId)
    .select(BOT_SELECT)
    .single()
  if (error) throw error
  if (runtimeSession) {
    const { error: sessionError } = await supabase
      .schema('openlink')
      .from('chat_sessions')
      .update({
        title: name,
        provider_id: selectedModel.providerId,
        model_id: selectedModel.modelId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', runtimeSession.id)
      .eq('user_id', userId)
      .eq('workspace_id', bot.workspaceId)
      .eq('surface', 'bot')
    if (sessionError) {
      // The profile is already durable in both authorities. A projection write
      // failure must not roll back a successful profile update; recovery will
      // resynchronize the session from the Bot row.
      console.error(`[openlink-bots] runtime session metadata update failed for ${bot.id}`, sessionError)
    }
  }
  return summary(data as BotRow)
}

export async function deleteBot(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
): Promise<void> {
  let runtimeSession: BotProjectionSession | null = null
  try {
    runtimeSession = await readOwnedBotRuntimeSession(supabase, userId, bot)
  } catch (error) {
    // A failed ownership read must not be treated as permission to release the
    // stored session id. The Bot row can still be deleted without touching the
    // runtime; a hidden-session orphan is safer than deleting Code state.
    console.error(`[openlink-bots] runtime session ownership check failed for ${bot.id}`, error)
  }
  if (runtimeSession) {
    await releaseBotRuntime({ ...bot, runtimeSessionId: runtimeSession.id }).catch((error) => {
      console.error('[openlink-bots] runtime session release deferred', error)
    })
  }
  try {
    await deleteBotAgent(bot.workAgentId)
  } catch (error) {
    // Bot deletion is an application operation. A missing local Work-host
    // store is already clean, and a transient Work-host outage must not leave
    // the user with an undeletable row. The orphaned agent directory is
    // reclaimed by Work-host's own data-retention policy.
    if (!isMissingWorkHostAgentError(error)) {
      console.error('[openlink-bots] Work Host agent cleanup deferred', error)
    }
  }
  const { error } = await supabase
    .schema('openlink')
    .from('bots')
    .delete()
    .eq('id', bot.id)
    .eq('user_id', userId)
  if (error) throw error
  if (runtimeSession) {
    const { error: sessionError } = await supabase
      .schema('openlink')
      .from('chat_sessions')
      .delete()
      .eq('id', runtimeSession.id)
      .eq('user_id', userId)
      .eq('workspace_id', bot.workspaceId)
      .eq('surface', 'bot')
    if (sessionError) {
      console.error('[openlink-bots] runtime session cleanup failed', sessionError)
    }
  }
}

export async function markBotViewed(
  supabase: ServerSupabaseClient,
  userId: string,
  botId: string,
): Promise<void> {
  if (!isBotId(botId)) return
  await supabase
    .schema('openlink')
    .from('bots')
    .update({ last_viewed_at: new Date().toISOString() })
    .eq('id', botId)
    .eq('user_id', userId)
}

export async function appendBotEntries(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
  entries: readonly BotTranscriptEntry[],
): Promise<void> {
  if (!entries.length) return
  const authoritativeBot = await appendToWorkHost(
    supabase,
    userId,
    bot,
    entries.map(toWorkHostEntry),
  )
  const preview = previewFromEntries(entries) || bot.lastEntryText
  try {
    const { error } = await supabase
      .schema('openlink')
      .from('bots')
      .update({
        ...(authoritativeBot.workAgentId === bot.workAgentId ? {} : { work_agent_id: authoritativeBot.workAgentId }),
        last_entry_text: preview.slice(0, 2000),
        last_activity_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', bot.id)
      .eq('user_id', userId)
    if (error) throw error
  } catch (error) {
    // The Work-host transcript is authoritative. A projection-update failure
    // must not turn an already-durable message into a failed turn; the next
    // detail read recomputes the sidebar preview from the transcript.
    console.error(`[openlink-bots] projection update failed for ${bot.id}`, error)
  }
}

export async function appendBotUserMessage(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
  content: string,
): Promise<BotTranscriptEntry> {
  const entry: BotTranscriptEntry = {
    kind: 'user-message',
    id: `bot-user-${randomUUID()}`,
    content,
    timestampMs: Date.now(),
  }
  await appendBotEntries(supabase, userId, bot, [entry])
  return entry
}

export async function getBotAvatar(bot: BotSummary): Promise<WorkHostAvatar | null> {
  try {
    return await getBotAgentAvatar(bot.workAgentId)
  } catch (error) {
    if (isMissingWorkHostAgentError(error)) return null
    throw error
  }
}

export async function resolveBotWorkspace(
  supabase: ServerSupabaseClient,
  workspaceSlug: string,
): Promise<OpenLinkWorkspace | null> {
  return await getAccessibleWorkspace(supabase, workspaceSlug)
}
