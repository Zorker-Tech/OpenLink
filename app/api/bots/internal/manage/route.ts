import { timingSafeEqual } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { BotInputError, createBot, createBotGroup, createBotRoutine, getBot, listBotRoutines, listBots, setBotRoutineEnabled, updateBot } from '@/lib/bots'
import { BOT_GROUP_MAX_MEMBERS } from '@/lib/bot-groups'
import type { BotSummary } from '@/lib/bot-types'
import { isLocalRuntime } from '@/lib/runtime-mode.server'
import { getAccessibleWorkspaceById } from '@/lib/workspaces'

export const runtime = 'nodejs'

const operations = new Map<string, Promise<unknown>>()
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

function scopedClient() {
  const local = isLocalRuntime()
  const url = local ? process.env.OPENLINK_LOCAL_ZOKERBASE_URL || process.env.OPENLINK_LOCAL_SUPABASE_URL
    : process.env.OPENLINK_CLOUD_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const secret = local ? process.env.OPENLINK_LOCAL_ZOKERBASE_SECRET_KEY || process.env.OPENLINK_LOCAL_SUPABASE_SECRET_KEY
    : process.env.OPENLINK_CLOUD_SUPABASE_SECRET_KEY
  return url && secret ? createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } }) : null
}

function json(payload: object, status = 200) {
  return Response.json(payload, { status, headers: { 'Cache-Control': 'no-store' } })
}

function authorized(request: Request): boolean {
  const token = process.env.OPENLINK_WORK_HOST_API_TOKEN
  if (!token) return false
  const expected = Buffer.from(`Bearer ${token}`)
  const actual = Buffer.from(request.headers.get('authorization') ?? '')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function publicFields(bot: BotSummary) {
  return { id: bot.id, name: bot.name, kind: bot.kind, memberIds: bot.memberIds }
}

async function serialize<T>(key: string, execute: () => Promise<T>): Promise<T> {
  const pending = (operations.get(key) ?? Promise.resolve()).catch(() => undefined).then(execute)
  operations.set(key, pending)
  try {
    return await pending
  } finally {
    if (operations.get(key) === pending) operations.delete(key)
  }
}

export async function POST(request: Request) {
  if (!authorized(request)) return json({ error: 'AUTH_REQUIRED' }, 401)
  const db = scopedClient()
  if (!db) return json({ error: 'BOT_DIRECTORY_UNAVAILABLE' }, 503)
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const { botId, agentId, userId, workspaceId, operationId, action, name, description, groupId, memberIds, routineId, schedule, prompt, isEnabled } = body ?? {}
  if (typeof botId !== 'string' || typeof agentId !== 'string' || typeof userId !== 'string' ||
      typeof workspaceId !== 'string' || typeof operationId !== 'string' || !idPattern.test(operationId)) {
    return json({ error: 'BOT_DIRECTORY_INVALID_REQUEST' }, 400)
  }
  if (memberIds !== undefined && (!Array.isArray(memberIds) || !memberIds.every(id => typeof id === 'string' && idPattern.test(id)))) {
    return json({ error: 'BOT_GROUP_MEMBER_INVALID' }, 400)
  }
  try {
    const source = await getBot(db, userId, botId)
    const workspace = await getAccessibleWorkspaceById(db, workspaceId)
    if (!workspace || !source || source.kind !== 'bot' || source.workAgentId !== agentId || source.workspaceId !== workspaceId) {
      return json({ error: 'BOT_DIRECTORY_FORBIDDEN' }, 403)
    }
    if (workspace.scope_type === 'organization') {
      const { data, error } = await db.schema('openlink').from('organization_members').select('user_id')
        .eq('organization_id', workspace.organization_id).eq('user_id', userId).maybeSingle()
      if (error) throw error
      if (!data) return json({ error: 'BOT_DIRECTORY_FORBIDDEN' }, 403)
    } else if (workspace.owner_id !== userId) {
      return json({ error: 'BOT_DIRECTORY_FORBIDDEN' }, 403)
    }
    if (action === 'list') {
      const bots = await listBots(db, userId, workspaceId)
      return json({ self: botId, entries: bots.filter(bot => bot.kind === 'bot' || bot.memberIds.includes(botId)).map(publicFields) })
    }
    if (action === 'list_routines') return json({ routines: await listBotRoutines(db, userId, source) })
    if (action === 'pause_routine' || action === 'resume_routine') {
      if (typeof routineId !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(routineId)) return json({ error: 'ROUTINE_INVALID' }, 400)
      const routines = await setBotRoutineEnabled(db, userId, source, routineId, action === 'resume_routine')
      const routine = routines.find(entry => entry.id === routineId)
      return routine ? json({ routine }) : json({ error: 'ROUTINE_NOT_FOUND' }, 404)
    }
    if (action === 'create_routine') {
      if (typeof name !== 'string' || !name.trim() || name.length > 80 || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000 ||
          typeof schedule !== 'string' || !/^[A-Za-z0-9*\/,?\- ]{1,160}$/.test(schedule) || schedule.trim().split(/\s+/).length !== 5 ||
          (isEnabled !== undefined && typeof isEnabled !== 'boolean')) return json({ error: 'ROUTINE_INVALID' }, 400)
      return await serialize(`routine:${botId}`, async () => {
        const before = await listBotRoutines(db, userId, source)
        const existing = before.find(entry => entry.name === name.trim() && entry.prompt === prompt.trim() && entry.schedule === schedule.trim())
        if (existing) return json({ routine: existing })
        const routines = await createBotRoutine(db, userId, source, {
          name: name.trim(), prompt: prompt.trim(), trigger: { type: 'cron', schedule: schedule.trim() }, isEnabled: isEnabled === true,
        })
        const created = routines.find(entry => !before.some(previous => previous.id === entry.id))
        return created ? json({ routine: created }, 201) : json({ error: 'ROUTINE_NOT_CREATED' }, 422)
      })
    }
    if (action === 'invite') {
      if (typeof groupId !== 'string' || !Array.isArray(memberIds) || !memberIds.length) {
        return json({ error: 'BOT_GROUP_MEMBER_REQUIRED' }, 400)
      }
      return await serialize(groupId, async () => {
        const group = await getBot(db, userId, groupId)
        if (!group || group.kind !== 'group' || group.workspaceId !== workspaceId || !group.memberIds.includes(botId)) {
          return json({ error: 'BOT_GROUP_NOT_FOUND' }, 404)
        }
        const additions = memberIds.filter(id => !group.memberIds.includes(id))
        const members = [...new Set([...group.memberIds, ...additions])]
        if (members.length > BOT_GROUP_MAX_MEMBERS) return json({ error: 'BOT_GROUP_FULL' }, 400)
        const updated = additions.length ? await updateBot(db, userId, group, { memberIds: members }) : group
        return json({ entry: publicFields(updated) })
      })
    }
    if (action !== 'create_bot' && action !== 'create_group') return json({ error: 'BOT_DIRECTORY_INVALID_ACTION' }, 400)
    return await serialize(operationId, async () => {
      const existing = await getBot(db, userId, operationId)
      if (existing) {
        if (existing.workspaceId !== workspaceId || existing.kind !== (action === 'create_group' ? 'group' : 'bot')) {
          return json({ error: 'BOT_DIRECTORY_OPERATION_CONFLICT' }, 409)
        }
        return json({ entry: publicFields(existing) })
      }
      if (action === 'create_group') {
        const members = [...new Set([botId, ...(memberIds ?? [])])]
        if (members.length > BOT_GROUP_MAX_MEMBERS) return json({ error: 'BOT_GROUP_FULL' }, 400)
        const group = await createBotGroup(db, userId, { workspaceSlug: workspace.slug, name, description, memberIds: members }, operationId)
        return json({ entry: publicFields(group) }, 201)
      }
      if (!source.projectId || !source.providerId || !source.modelId) return json({ error: 'BOT_RUNTIME_NOT_READY' }, 409)
      const bot = await createBot(db, userId, {
        workspaceSlug: workspace.slug, name, description, model: { providerId: source.providerId, modelId: source.modelId },
      }, { id: operationId, projectId: source.projectId })
      return json({ entry: publicFields(bot) }, 201)
    })
  } catch (error) {
    if (error instanceof BotInputError) return json({ error: error.message }, 400)
    console.error('[openlink-bots] directory operation failed', error)
    return json({ error: 'BOT_DIRECTORY_OPERATION_FAILED' }, 502)
  }
}
