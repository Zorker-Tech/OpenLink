import { listBots, resolveBotWorkspace } from '@/lib/bots'
import type { BotRailActivity, BotRailAvatar, BotRailEvent } from '@/lib/bot-rail'
import { botRailActivityFromWorkHostFrame, workHostBotAvatarState } from '@/lib/bot-work-host-stream'
import { listWorkHostBotActivity, workHostConfig } from '@/lib/work-host-client.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 3600

const encoder = new TextEncoder()

function appearance(bot: { id: string; avatarShape: string; avatarColor: string }): BotRailAvatar {
  return { id: bot.id, shape: bot.avatarShape, color: bot.avatarColor }
}

export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get('workspace')?.trim()
  if (!slug) return new Response(null, { status: 400 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(null, { status: 401 })
  const workspace = await resolveBotWorkspace(supabase, slug)
  if (!workspace) return new Response(null, { status: 404 })

  const config = workHostConfig()
  const lifetime = new AbortController()
  const signal = AbortSignal.any([request.signal, lifetime.signal])
  const loadRoster = () => listBots(supabase, user.id, workspace.id)
  const [initialRoster, upstream] = await Promise.all([
    loadRoster(),
    config ? fetch(`${config.baseUrl}/events?channels=agents,agent-upserted,bot-turn,transcript`, {
      headers: { Authorization: `Bearer ${config.apiToken}`, Accept: 'text/event-stream', 'X-Slate-Slim-Avatars': '1' },
      cache: 'no-store',
      signal,
    }).catch(() => null) : null,
  ])
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      let roster = new Map(initialRoster.map(bot => [bot.workAgentId, bot]))
      const active = new Map<string, BotRailActivity>()
      const enqueue = (value: string) => {
        if (closed) return
        try { controller.enqueue(encoder.encode(value)) } catch {
          closed = true
          lifetime.abort()
        }
      }
      enqueue('retry: 5000\n\n')
      const send = (value: BotRailEvent) => {
        enqueue(`data: ${JSON.stringify(value)}\n\n`)
      }
      const sendSnapshot = () => send({
        type: 'snapshot',
        idle: [...roster.values()].filter(bot => bot.kind === 'bot').map(appearance),
        active: [...active.values()],
      })
      const apply = (agentId: string, state: string | null, memberId?: string, live = true) => {
        const bot = roster.get(agentId)
        if (!bot) return
        const member = memberId ? bot.members.find(item => item.workAgentId === memberId) : undefined
        if (memberId && !member) return
        const previous = active.get(bot.id)
        const avatar = member ? appearance(member) : appearance(bot)
        const next = state ? { sessionId: bot.id, avatar, state } : null
        if (previous?.state === next?.state && previous?.avatar.id === next?.avatar.id
            && previous?.avatar.shape === next?.avatar.shape && previous?.avatar.color === next?.avatar.color) return
        if (next) active.set(bot.id, next)
        else active.delete(bot.id)
        if (live) send({ type: 'activity', sessionId: bot.id, active: next })
      }

      let lastRosterRead = Date.now()
      const refreshRoster = async () => {
        if (Date.now() - lastRosterRead < 3_000) return
        lastRosterRead = Date.now()
        const next = await loadRoster().catch(() => null)
        if (!next || closed) return
        roster = new Map(next.map(bot => [bot.workAgentId, bot]))
        const current = new Set(next.map(bot => bot.id))
        for (const id of active.keys()) {
          if (!current.has(id)) active.delete(id)
        }
        sendSnapshot()
      }
      const reader = upstream?.ok ? upstream.body?.getReader() : undefined
      if (!reader) {
        sendSnapshot()
        controller.close()
        return
      }

      const heartbeat = setInterval(() => enqueue(': ping\n\n'), 15_000)
      const refresh = setInterval(() => { void refreshRoster() }, 30_000)
      heartbeat.unref?.()
      refresh.unref?.()
      try {
        const current = await listWorkHostBotActivity(signal).catch(() => [])
        for (const agent of current) apply(agent.id, workHostBotAvatarState(agent), undefined, false)
        sendSnapshot()

        const decoder = new TextDecoder()
        let buffer = ''
        while (!signal.aborted) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data:')) continue
            const frame = readEvent(line.slice(5).trim())
            if (!frame) continue
            if (frame.channel === 'agents') {
              const agents = (frame.payload as { agents?: unknown } | null)?.agents
              if (Array.isArray(agents)) {
                for (const agent of agents) {
                  if (typeof agent?.id !== 'string' || typeof agent.isRunning !== 'boolean') continue
                  if (roster.get(agent.id)?.kind !== 'group') apply(agent.id, workHostBotAvatarState(agent))
                }
              }
              void refreshRoster()
              continue
            }
            const update = botRailActivityFromWorkHostFrame(frame)
            if (!update) continue
            if (!roster.has(update.agentId)) {
              await refreshRoster()
            }
            if (frame.channel === 'agent-upserted' && roster.get(update.agentId)?.kind === 'group') continue
            apply(update.agentId, update.state, update.memberId)
          }
        }
      } catch {
        // The browser reconnects after the Work-host gateway or request closes.
      } finally {
        closed = true
        clearInterval(heartbeat)
        clearInterval(refresh)
        try { reader.releaseLock() } catch {}
        try { controller.close() } catch {}
      }
    },
    cancel() { lifetime.abort() },
  })
  return new Response(stream, { headers: {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  } })
}

function readEvent(value: string): { channel?: unknown; payload?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch { return null }
}
