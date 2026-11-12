import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import { resolveConfiguredModelSelection } from '@/lib/ai-provider-configurations.server'
import {
  chunkWorkHostEntries,
  fromDurableGroupEntry,
  normalizeWorkHostTranscript,
  pendingConfirmationsFromTranscript,
  previewFromEntries,
  toWorkHostEntry,
  transcriptFromAgentEvents,
  type BotTranscriptEntry,
} from '@/lib/bot-transcript'
import { isBotAvatarColor, isBotAvatarShape } from '@/lib/bot-avatar'
import { assertGroupMemberCandidate, isGroupBot, normalizeGroupMemberIds } from '@/lib/bot-groups'
import { releaseBotRuntime } from '@/lib/bot-runtime.server'
import type { BotDetail, BotGroupMemberSummary, BotRoutine, BotRuntimeStatus, BotSummary } from '@/lib/bot-types'
import {
  pendingBotConfirmations,
  type BotConfirmationRequest,
} from '@/lib/bot-confirmations'
import { listPersistedChatEvents, listPersistedConfirmationEvents } from '@/lib/chat-session-persistence.server'
import { ensureDraftProject } from '@/lib/projects'
import { getAccessibleWorkspace, getAccessibleWorkspaceById, type OpenLinkWorkspace } from '@/lib/workspaces'
import {
  appendBotAgentTranscriptEntries,
  createBotAgent,
  createBotAgentAutomation,
  createBotGroup as createWorkHostGroup,
  deleteBotAgent,
  deleteBotAgentAutomation,
  getBotAgentAutomations,
  getBotAgentAvatar,
  getBotAgentTranscript,
  isMissingWorkHostAgentError,
  runBotAgentAutomationNow,
  setBotAgentAvatar,
  setBotAgentAutomationEnabled,
  setBotGroupMembers,
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
const SAFE_MODEL_ID = /^[A-Za-z0-9@][A-Za-z0-9._:/@-]{0,255}$/
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

/**
 * The stable execution key for a Bot. It is derived from the Bot's own
 * identity, so it survives a Work-host data-root restore and never collides
 * with a Code chat session.
 */
export function botRuntimeKey(botId: string): string {
  return `bot-${botId}`
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

/**
 * Ensure the durable projection a Bot turn needs: a Work-host agent, a Project
 * VM identity and a stable runtime key.
 *
 * This is deliberately not a session repair. The Bot's execution identity is
 * derived from its own row (`bot-<botId>`), so there is no hidden chat session
 * to recreate, adopt or delete. A legacy `runtime_session_id` is read only by
 * the transcript migration path.
 */
export async function ensureBotRuntimeProjection(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
): Promise<BotSummary> {
  return await withBotProjectionLock(bot.id, async () => {
    const latest = await getBot(supabase, userId, bot.id)
    if (!latest) throw new BotInputError('BOT_NOT_FOUND')
    // A group is a Work-host identity and routing projection only. Its members
    // own the isolated execution sandboxes, so a group must never acquire a
    // Project or a runtime key of its own. Its Work-host routing identity is
    // still recoverable from the durable group row.
    if (isGroupBot(latest)) {
      try {
        await getBotAgentTranscript(latest.workAgentId)
        return latest
      } catch (error) {
        if (!isMissingWorkHostAgentError(error)) throw error
        return await recoverBotGroupAgent(supabase, userId, latest)
      }
    }

    // A lost Work-host agent store is recoverable from the durable Bot row.
    // The transcript itself is reconciled by the detail read, which is the
    // only place that needs the full history.
    let authoritative = latest
    try {
      await getBotAgentTranscript(latest.workAgentId)
    } catch (error) {
      if (!isMissingWorkHostAgentError(error)) throw error
      authoritative = await recreateBotAgent(supabase, userId, latest)
    }

    let projectId = authoritative.projectId
    if (projectId) {
      const { data, error } = await supabase
        .schema('openlink')
        .from('projects')
        .select('id, workspace_id')
        .eq('id', projectId)
        .eq('workspace_id', authoritative.workspaceId)
        .maybeSingle()
      // A transient Project read failure is not evidence that the Project was
      // lost. Do not replace a healthy Project because a restore is still
      // settling; the caller retries the same idempotent operation.
      if (error) throw new Error('BOT_PROJECTION_READ_FAILED')
      if (!data) projectId = null
    }
    if (!projectId) {
      const workspace = await getAccessibleWorkspaceById(supabase, authoritative.workspaceId)
      if (!workspace || workspace.id !== authoritative.workspaceId) throw new BotInputError('BOT_WORKSPACE_NOT_FOUND')
      const project = await ensureDraftProject(supabase, userId, workspace)
      projectId = project.id
    }

    const projectChanged = projectId !== authoritative.projectId
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .schema('openlink')
      .from('bots')
      .update({
        project_id: projectId,
        runtime_status: projectChanged ? 'pending' : authoritative.runtimeStatus,
        runtime_ready_at: projectChanged ? null : authoritative.runtimeReadyAt,
        runtime_last_error: projectChanged ? null : authoritative.runtimeLastError,
        runtime_checked_at: now,
        updated_at: now,
      })
      .eq('id', authoritative.id)
      .eq('user_id', userId)
      .select(BOT_SELECT)
      .maybeSingle()
    if (error) throw error
    if (!data) {
      const raced = await getBot(supabase, userId, authoritative.id)
      if (!raced) throw new BotInputError('BOT_NOT_FOUND')
      return raced
    }
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

/**
 * Recreate a lost Work-host group agent from the durable group row. The group
 * has no sandbox of its own; its members keep their bindings, so recovery only
 * has to restore the routing identity and membership.
 */
async function recoverBotGroupAgent(
  supabase: ServerSupabaseClient,
  userId: string,
  group: BotSummary,
): Promise<BotSummary> {
  const previous = BOT_AGENT_RECOVERY_LOCKS.get(group.id) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.then(() => current)
  BOT_AGENT_RECOVERY_LOCKS.set(group.id, queued)
  await previous.catch(() => undefined)
  try {
    const latest = await getBot(supabase, userId, group.id)
    if (!latest) throw new BotInputError('BOT_NOT_FOUND')
    if (!isGroupBot(latest)) return latest
    if (latest.workAgentId !== group.workAgentId) return latest

    const members = await readGroupMemberBots(supabase, userId, latest.workspaceId, latest.memberIds)
    const created = await createWorkHostGroup({
      name: latest.name,
      description: latest.description,
      memberAgentIds: members.map((member) => member.workAgentId),
      externalId: latest.id,
    })
    await syncGroupAgentProfile({
      id: created.agent.id,
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
      // Do not delete the returned agent: `createGroup` may have matched an
      // existing group by its external id, and that agent may already be the
      // one another writer is using.
      throw error
    }
    if (!data) {
      const raced = await getBot(supabase, userId, group.id)
      if (!raced) throw new BotInputError('BOT_NOT_FOUND')
      return raced
    }
    return summary(data as BotRow, members.map((member) => ({
      id: member.id,
      name: member.name,
      workAgentId: member.workAgentId,
      avatarShape: member.avatarShape,
      avatarColor: member.avatarColor,
      updatedAt: member.updatedAt,
    })))
  } finally {
    release()
    if (BOT_AGENT_RECOVERY_LOCKS.get(group.id) === queued) BOT_AGENT_RECOVERY_LOCKS.delete(group.id)
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

/**
 * Record that a Bot question was answered. The Work-host transcript is the
 * durable source, so a reopened Bot does not show the same question again.
 * The entry id is derived from the extension UI id, which makes the write
 * idempotent across a retried answer.
 */
export async function appendBotConfirmationResolved(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
  extensionUiId: string,
): Promise<void> {
  // The marker id is bounded independently of the extension UI id so a long
  // provider dialog id cannot exceed the Work-host entry-id limit.
  const marker = createHash('sha256').update(extensionUiId).digest('hex').slice(0, 32)
  const entry = {
    id: `confirmation-resolved-${marker}`,
    kind: 'event',
    event: { type: 'confirmation-resolved', extensionUiId },
    timestampMs: Date.now(),
  }
  try {
    await appendBotAgentTranscriptEntries(bot.workAgentId, [entry])
  } catch (error) {
    if (!isMissingWorkHostAgentError(error)) throw error
    const recovered = await recreateBotAgent(supabase, userId, bot)
    await appendBotAgentTranscriptEntries(recovered.workAgentId, [entry])
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

/**
 * The sidebar preview is a projection of the Work-host transcript. Refresh it
 * on a detail read so a reload does not show a stale line after a turn that
 * was written by the Bot control plane.
 */
async function syncBotPreview(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
  transcript: readonly BotTranscriptEntry[],
): Promise<string | null> {
  const preview = previewFromEntries(transcript)
  if (!preview || preview === bot.lastEntryText) return preview || null
  const last = transcript[transcript.length - 1]
  const currentActivity = Date.parse(bot.lastActivityAt)
  const activityAt = last === undefined
    ? new Date().toISOString()
    : new Date(Number.isFinite(currentActivity) ? Math.max(currentActivity, last.timestampMs) : last.timestampMs).toISOString()
  try {
    const { error } = await supabase
      .schema('openlink')
      .from('bots')
      .update({
        last_entry_text: preview.slice(0, 2000),
        last_activity_at: activityAt,
      })
      .eq('id', bot.id)
      .eq('user_id', userId)
    if (error) console.error(`[openlink-bots] preview projection update failed for ${bot.id}`, error)
  } catch (error) {
    console.error(`[openlink-bots] preview projection update failed for ${bot.id}`, error)
  }
  return preview
}

function summary(row: BotRow, members: BotGroupMemberSummary[] = []): BotSummary {
  return {
    id: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    runtimeKey: botRuntimeKey(row.id),
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

async function readDurableGroupTranscript(
  supabase: ServerSupabaseClient,
  userId: string,
  group: BotSummary,
): Promise<BotTranscriptEntry[]> {
  const { data, error } = await supabase
    .schema('openlink')
    .from('bot_group_entries')
    .select('payload')
    .eq('bot_id', group.id)
    .eq('user_id', userId)
    .eq('workspace_id', group.workspaceId)
    .order('sequence', { ascending: true })
  if (error) throw error
  return ((data ?? []) as Array<{ payload: unknown }>).flatMap((row) => {
    const entry = fromDurableGroupEntry(row.payload)
    return entry ? [entry] : []
  })
}

async function readGroupMemberBots(
  supabase: ServerSupabaseClient,
  userId: string,
  workspaceId: string,
  memberIds: readonly string[],
): Promise<BotSummary[]> {
  const ids = normalizeGroupMemberIds(memberIds)
  if (!ids.length) throw new BotInputError('BOT_GROUP_MEMBER_INVALID')
  const { data, error } = await supabase
    .schema('openlink')
    .from('bots')
    .select(BOT_SELECT)
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .eq('kind', 'bot')
    .in('id', ids)
  if (error) throw error
  const byId = new Map(((data ?? []) as BotRow[]).map((row) => [row.id, summary(row)]))
  const members = ids.flatMap((id) => {
    const member = byId.get(id)
    return member ? [member] : []
  })
  if (members.length !== ids.length) throw new BotInputError('BOT_GROUP_MEMBER_INVALID')
  for (const member of members) assertGroupMemberCandidate(member, workspaceId)
  return members
}

/** Keep the Work-host group profile's avatar identity aligned with the row. */
async function syncGroupAgentProfile(input: {
  id: string
  name: string
  description: string
  avatarShape: string
  avatarColor: string
}): Promise<void> {
  try {
    await updateBotAgent(input)
  } catch (error) {
    if (!isMissingWorkHostAgentError(error)) {
      console.error(`[openlink-bots] group profile avatar sync failed for ${input.id}`, error)
    }
  }
}

async function updateGroupWorkHostIdentity(
  supabase: ServerSupabaseClient,
  userId: string,
  group: BotSummary,
  input: {
    name: string
    description: string
    memberIds: string[]
    avatarShape: string
    avatarColor: string
    avatarPngBase64: string | null
  },
): Promise<string> {
  const members = await readGroupMemberBots(supabase, userId, group.workspaceId, input.memberIds)
  const memberAgentIds = members.map((member) => member.workAgentId)
  let agentId = group.workAgentId
  try {
    await updateBotAgent({
      id: agentId,
      name: input.name,
      description: input.description,
      avatarShape: input.avatarShape,
      avatarColor: input.avatarColor,
    })
    await setBotGroupMembers(agentId, memberAgentIds)
  } catch (error) {
    if (!isMissingWorkHostAgentError(error)) throw error
    const created = await createWorkHostGroup({
      name: input.name,
      description: input.description,
      memberAgentIds,
      externalId: group.id,
    })
    agentId = created.agent.id
    await syncGroupAgentProfile({
      id: agentId,
      name: input.name,
      description: input.description,
      avatarShape: input.avatarShape,
      avatarColor: input.avatarColor,
    })
  }
  if (input.avatarPngBase64) await setBotAgentAvatar(agentId, input.avatarPngBase64)
  return agentId
}

interface BotGroupMemberRow {
  id: string
  workspace_id: string
  kind: 'bot' | 'group'
  name: string
  work_agent_id: string
  avatar_shape: string
  avatar_color: string
  updated_at: string
}

function groupMemberSummary(row: BotGroupMemberRow): BotGroupMemberSummary {
  return {
    id: row.id,
    name: row.name,
    workAgentId: row.work_agent_id,
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
    .select('id, workspace_id, kind, name, work_agent_id, avatar_shape, avatar_color, updated_at')
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

function normalizeAvatar(value: unknown, fallback: string, kind: 'shape' | 'color'): string {
  const candidate = typeof value === 'string' ? value.trim() : ''
  const valid = SAFE_AVATAR_ID.test(candidate)
    && (kind === 'shape' ? isBotAvatarShape(candidate) : isBotAvatarColor(candidate))
  if (!valid) {
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
  if (isGroupBot(bot)) {
    let authoritative = bot
    try {
      // A lost Work-host group agent is recoverable from the durable group
      // row; recovery preserves the member set and the routing identity.
      authoritative = await ensureBotRuntimeProjection(supabase, userId, bot)
    } catch (error) {
      console.error(`[openlink-bots] group agent recovery failed for ${bot.id}`, error)
    }
    let transcript: BotTranscriptEntry[] = []
    let runtimeReady = authoritative.members.length > 0
    try {
      // The group agent's Work-host transcript is the authority: member
      // messages are posted into the group room with their author metadata.
      transcript = normalizeWorkHostTranscript(await getBotAgentTranscript(authoritative.workAgentId))
    } catch (error) {
      if (!isMissingWorkHostAgentError(error)) {
        console.error(`[openlink-bots] group transcript read failed for ${bot.id}`, error)
      }
      runtimeReady = false
    }
    if (!transcript.length) {
      // Migration input: groups created before the Work-host group transcript
      // existed kept their timeline in the application projection.
      try {
        transcript = await readDurableGroupTranscript(supabase, userId, authoritative)
      } catch (error) {
        console.error(`[openlink-bots] legacy group transcript read failed for ${bot.id}`, error)
      }
    }
    const preview = await syncBotPreview(supabase, userId, authoritative, transcript)
    return {
      ...authoritative,
      ...(preview ? { lastEntryText: preview } : {}),
      transcript,
      runtimeReady,
      pendingConfirmations: [],
      routines: [],
    }
  }
  let transcript: BotTranscriptEntry[] = []
  let rawEntries: Record<string, unknown>[] = []
  let authoritativeBot = await ensureBotRuntimeProjection(supabase, userId, bot)
  let readError: unknown = null
  let pendingConfirmations: BotConfirmationRequest[] = []
  let routines: BotRoutine[] = []
  try {
    const read = await readBotTranscript(supabase, userId, authoritativeBot)
    authoritativeBot = read.bot
    rawEntries = read.entries
    transcript = normalizeWorkHostTranscript(read.entries)
  } catch (error) {
    readError = error
    console.error(`[openlink-bots] transcript read failed for ${bot.id}`, error)
  }
  // Work-host is the transcript authority. A Bot that predates the Work-host
  // control plane may still have a hidden Code session; that event log is
  // migration input only. The completion marker makes the migration
  // resumable: an interrupted append is retried on the next read, and an
  // already-complete Bot never reads the legacy log again.
  const legacyMigrationComplete = rawEntries.some((entry) => (
    entry.kind === 'event'
    && entry.event !== null
    && typeof entry.event === 'object'
    && !Array.isArray(entry.event)
    && (entry.event as Record<string, unknown>).type === 'legacy-migration-complete'
  ))
  if (!legacyMigrationComplete && authoritativeBot.runtimeSessionId) {
    try {
      const events = await listPersistedChatEvents(supabase, userId, authoritativeBot.runtimeSessionId)
      const migrated = transcriptFromAgentEvents(events)
      if (migrated.length) {
        transcript = migrated
        await appendToWorkHost(supabase, userId, authoritativeBot, migrated.map(toWorkHostEntry))
          .then(async (nextBot) => {
            authoritativeBot = nextBot
            // A partial earlier migration may already have Work-host-only
            // entries. Re-read the authority so the returned timeline is the
            // union, not the legacy log alone.
            try {
              const refreshed = await getBotAgentTranscript(nextBot.workAgentId)
              rawEntries = refreshed
              transcript = normalizeWorkHostTranscript(refreshed)
            } catch {
              // Keep the migrated view; the next read retries the mirror.
            }
          })
          .catch((error) => {
            console.error(`[openlink-bots] legacy transcript migration failed for ${bot.id}`, error)
          })
      }
      await appendBotAgentTranscriptEntries(authoritativeBot.workAgentId, [{
        id: 'legacy-migration-complete',
        kind: 'event',
        event: { type: 'legacy-migration-complete' },
        timestampMs: Date.now(),
      }]).catch((error) => {
        console.error(`[openlink-bots] legacy migration marker could not be written for ${bot.id}`, error)
      })
    } catch (error) {
      console.error(`[openlink-bots] legacy transcript read failed for ${bot.id}`, error)
    }
  }
  pendingConfirmations = pendingConfirmationsFromTranscript(transcript)
  if (!pendingConfirmations.length && !transcript.length && authoritativeBot.runtimeSessionId) {
    try {
      pendingConfirmations = pendingBotConfirmations(
        await listPersistedConfirmationEvents(supabase, userId, authoritativeBot.runtimeSessionId),
      )
    } catch (error) {
      console.error(`[openlink-bots] legacy confirmation read failed for ${bot.id}`, error)
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
  const preview = await syncBotPreview(supabase, userId, authoritativeBot, transcript)
  return {
    ...authoritativeBot,
    ...(preview ? { lastEntryText: preview } : {}),
    transcript,
    runtimeReady: authoritativeBot.runtimeStatus === 'ready',
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
  const avatarShape = normalizeAvatar(input.avatarShape, 'blob', 'shape')
  const avatarColor = normalizeAvatar(input.avatarColor, 'orange', 'color')
  const avatarPngBase64 = normalizePng(input.avatarPngBase64)
  const requestedModel = normalizeModel(input.model)
  const selectedModel = await resolveConfiguredModelSelection(supabase, userId, requestedModel)
  if (!selectedModel) throw new BotInputError('BOT_MODEL_REQUIRED')
  const project = await ensureDraftProject(supabase, userId, workspace)
  let createdAgentId: string | null = null
  try {
    const created = await createBotAgent({
      name,
      description,
      avatarShape,
      avatarColor,
    })
    createdAgentId = created.agent.id
    if (avatarPngBase64) await setBotAgentAvatar(created.agent.id, avatarPngBase64)
    // A new Bot has no Code session. Its execution identity is derived from
    // its own row by `runtimeKey`, so there is no hidden chat row to create,
    // migrate or clean up.
    const { data, error } = await supabase
      .schema('openlink')
      .from('bots')
      .insert({
        user_id: userId,
        workspace_id: workspace.id,
        project_id: project.id,
        runtime_session_id: null,
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
    if (createdAgentId) await deleteBotAgent(createdAgentId).catch(() => undefined)
    throw error
  }
}

export async function createBotGroup(
  supabase: ServerSupabaseClient,
  userId: string,
  input: {
    workspaceSlug: string
    name: unknown
    description?: unknown
    avatarShape?: unknown
    avatarColor?: unknown
    avatarPngBase64?: unknown
    memberIds: unknown
  },
): Promise<BotSummary> {
  const workspace = await getAccessibleWorkspace(supabase, input.workspaceSlug)
  if (!workspace) throw new BotInputError('BOT_WORKSPACE_NOT_FOUND')
  const name = normalizeName(input.name)
  const description = normalizeDescription(input.description)
  const avatarShape = normalizeAvatar(input.avatarShape, 'blob', 'shape')
  const avatarColor = normalizeAvatar(input.avatarColor, 'orange', 'color')
  const avatarPngBase64 = normalizePng(input.avatarPngBase64)
  const memberIds = normalizeGroupMemberIds(input.memberIds)
  if (!memberIds.length) throw new BotInputError('BOT_GROUP_MEMBER_REQUIRED')
  const members = await readGroupMemberBots(supabase, userId, workspace.id, memberIds)
  const botId = randomUUID()
  let createdAgentId: string | null = null
  try {
    const created = await createWorkHostGroup({
      name,
      description,
      memberAgentIds: members.map((member) => member.workAgentId),
      externalId: botId,
    })
    createdAgentId = created.agent.id
    await syncGroupAgentProfile({
      id: created.agent.id,
      name,
      description,
      avatarShape,
      avatarColor,
    })
    if (avatarPngBase64) await setBotAgentAvatar(created.agent.id, avatarPngBase64)
    const { data, error } = await supabase
      .schema('openlink')
      .from('bots')
      .insert({
        id: botId,
        user_id: userId,
        workspace_id: workspace.id,
        project_id: null,
        runtime_session_id: null,
        runtime_status: 'ready',
        runtime_ready_at: new Date().toISOString(),
        work_agent_id: created.agent.id,
        name,
        description,
        avatar_shape: avatarShape,
        avatar_color: avatarColor,
        kind: 'group',
        member_ids: memberIds,
        provider_id: null,
        model_id: null,
        last_entry_text: '',
        last_activity_at: new Date().toISOString(),
        last_viewed_at: new Date().toISOString(),
      })
      .select(BOT_SELECT)
      .single()
    if (error) throw error
    return summary(data as BotRow, members.map((member) => ({
      id: member.id,
      name: member.name,
      workAgentId: member.workAgentId,
      avatarShape: member.avatarShape,
      avatarColor: member.avatarColor,
      updatedAt: member.updatedAt,
    })))
  } catch (error) {
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
    memberIds?: unknown
  },
): Promise<BotSummary> {
  const name = input.name === undefined ? bot.name : normalizeName(input.name)
  const description = input.description === undefined ? bot.description : normalizeDescription(input.description)
  const avatarShape = input.avatarShape === undefined ? bot.avatarShape : normalizeAvatar(input.avatarShape, bot.avatarShape, 'shape')
  const avatarColor = input.avatarColor === undefined ? bot.avatarColor : normalizeAvatar(input.avatarColor, bot.avatarColor, 'color')
  const avatarPngBase64 = normalizePng(input.avatarPngBase64)
  if (isGroupBot(bot)) {
    const memberIds = input.memberIds === undefined
      ? bot.memberIds
      : normalizeGroupMemberIds(input.memberIds)
    if (!memberIds.length) throw new BotInputError('BOT_GROUP_MEMBER_REQUIRED')
    const members = await readGroupMemberBots(supabase, userId, bot.workspaceId, memberIds)
    const agentId = await updateGroupWorkHostIdentity(supabase, userId, bot, {
      name,
      description,
      memberIds,
      avatarShape,
      avatarColor,
      avatarPngBase64,
    })
    const { data, error } = await supabase
      .schema('openlink')
      .from('bots')
      .update({
        ...(agentId === bot.workAgentId ? {} : { work_agent_id: agentId }),
        name,
        description,
        avatar_shape: avatarShape,
        avatar_color: avatarColor,
        member_ids: memberIds,
        updated_at: new Date().toISOString(),
      })
      .eq('id', bot.id)
      .eq('user_id', userId)
      .select(BOT_SELECT)
      .single()
    if (error) throw error
    return summary(data as BotRow, members.map((member) => ({
      id: member.id,
      name: member.name,
      workAgentId: member.workAgentId,
      avatarShape: member.avatarShape,
      avatarColor: member.avatarColor,
      updatedAt: member.updatedAt,
    })))
  }
  const requestedModel = input.model === undefined
    ? (bot.providerId && bot.modelId ? { providerId: bot.providerId, modelId: bot.modelId } : null)
    : normalizeModel(input.model)
  if (!requestedModel) throw new BotInputError('BOT_MODEL_REQUIRED')
  const selectedModel = await resolveConfiguredModelSelection(supabase, userId, requestedModel)
  if (!selectedModel) throw new BotInputError('BOT_MODEL_REQUIRED')
  const modelChanged = selectedModel.providerId !== bot.providerId || selectedModel.modelId !== bot.modelId
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
  if (modelChanged) {
    // The substrate's runtime identity includes the model. Release the old
    // sandbox so the next ensure provisions the new identity; a failed release
    // is safe because ensure replaces the workload by identity anyway.
    await releaseBotRuntime(bot)
  }
  return summary(data as BotRow)
}

/**
 * A deleted Bot cannot remain a group member. Remove it from every group row
 * and from the Work-host group identity; a group that loses its last member is
 * deleted because it can no longer answer.
 */
async function removeBotFromGroups(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
): Promise<void> {
  let groups: Array<{ id: string; work_agent_id: string; member_ids: string[] | null }>
  try {
    const { data, error } = await supabase
      .schema('openlink')
      .from('bots')
      .select('id, work_agent_id, member_ids')
      .eq('user_id', userId)
      .eq('workspace_id', bot.workspaceId)
      .eq('kind', 'group')
      .contains('member_ids', [bot.id])
    if (error) throw error
    groups = (data ?? []) as typeof groups
  } catch (error) {
    console.error(`[openlink-bots] group membership cleanup read failed for ${bot.id}`, error)
    return
  }
  for (const group of groups) {
    const remainingIds = (group.member_ids ?? []).filter((id) => id !== bot.id)
    if (!remainingIds.length) {
      try {
        await deleteBotAgent(group.work_agent_id)
      } catch (error) {
        if (!isMissingWorkHostAgentError(error)) {
          console.error(`[openlink-bots] empty group agent cleanup deferred for ${group.id}`, error)
        }
      }
      const { error } = await supabase
        .schema('openlink')
        .from('bots')
        .delete()
        .eq('id', group.id)
        .eq('user_id', userId)
        .eq('kind', 'group')
      if (error) console.error(`[openlink-bots] empty group cleanup failed for ${group.id}`, error)
      continue
    }
    try {
      const members = await readGroupMemberBots(supabase, userId, bot.workspaceId, remainingIds)
      await setBotGroupMembers(group.work_agent_id, members.map((member) => member.workAgentId))
    } catch (error) {
      if (!isMissingWorkHostAgentError(error)) {
        console.error(`[openlink-bots] group membership cleanup deferred for ${group.id}`, error)
      }
    }
    const { error } = await supabase
      .schema('openlink')
      .from('bots')
      .update({ member_ids: remainingIds, updated_at: new Date().toISOString() })
      .eq('id', group.id)
      .eq('user_id', userId)
      .eq('kind', 'group')
    if (error) console.error(`[openlink-bots] group membership cleanup failed for ${group.id}`, error)
  }
}

export async function deleteBot(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
): Promise<void> {
  if (isGroupBot(bot)) {
    try {
      await deleteBotAgent(bot.workAgentId)
    } catch (error) {
      if (!isMissingWorkHostAgentError(error)) {
        console.error('[openlink-bots] Work Host group cleanup deferred', error)
      }
    }
    const { error } = await supabase
      .schema('openlink')
      .from('bots')
      .delete()
      .eq('id', bot.id)
      .eq('user_id', userId)
      .eq('kind', 'group')
    if (error) throw error
    return
  }
  await removeBotFromGroups(supabase, userId, bot)
  await releaseBotRuntime(bot)
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
  if (bot.runtimeSessionId) {
    // Legacy migration cleanup only: a row that predates the Work-host control
    // plane may still point at a hidden Bot session. The `surface = 'bot'`
    // guard means an ordinary Code session can never be deleted here.
    const { error: sessionError } = await supabase
      .schema('openlink')
      .from('chat_sessions')
      .delete()
      .eq('id', bot.runtimeSessionId)
      .eq('user_id', userId)
      .eq('workspace_id', bot.workspaceId)
      .eq('surface', 'bot')
    if (sessionError) {
      console.error('[openlink-bots] legacy runtime session cleanup failed', sessionError)
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
