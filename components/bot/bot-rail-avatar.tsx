'use client'

import { AgentAvatar } from '@zorker/avatar'
import { useReducedMotion } from 'motion/react'
import { useEffect, useState } from 'react'
import { useOpenLinkTheme } from '@/components/ui/theme-scope'
import type { BotRailActivity, BotRailAvatar as AvatarAppearance, BotRailEvent } from '@/lib/bot-rail'

const ROTATION_MS = 8_000
const PREVIEW_AVATARS: AvatarAppearance[] = [
  { id: 'preview-blob', shape: 'blob', color: 'orange' },
  { id: 'preview-pebble', shape: 'pebble', color: 'violet' },
  { id: 'preview-cloud', shape: 'cloud', color: 'green' },
  { id: 'preview-gem', shape: 'gem', color: 'magenta' },
]

export function BotRailAvatar({ workspaceSlug, activeSessionId }: { workspaceSlug: string; activeSessionId?: string }) {
  const theme = useOpenLinkTheme()
  const reducedMotion = useReducedMotion() === true
  const [snapshot, setSnapshot] = useState<{ idle: AvatarAppearance[]; active: BotRailActivity[] }>({ idle: [], active: [] })
  const [rotation, setRotation] = useState(0)
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden')
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  useEffect(() => {
    const source = new EventSource(`/api/bots/activity?workspace=${encodeURIComponent(workspaceSlug)}`)
    source.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data) as BotRailEvent
        if (frame.type === 'snapshot') {
          setSnapshot({ idle: frame.idle, active: frame.active })
        } else if (frame.type === 'activity') {
          setSnapshot(previous => {
            const active = previous.active.filter(item => item.sessionId !== frame.sessionId)
            if (frame.active) active.push(frame.active)
            return { ...previous, active }
          })
        }
      } catch {}
    }
    source.onerror = () => setSnapshot(previous => previous.active.length ? { ...previous, active: [] } : previous)
    return () => source.close()
  }, [workspaceSlug])

  const running = snapshot.active.find(item => item.sessionId === activeSessionId) ?? snapshot.active.at(-1)
  const isRunning = running !== undefined
  useEffect(() => {
    if (isRunning || !visible) return
    const timer = window.setInterval(() => setRotation(previous => previous + 1), ROTATION_MS)
    return () => window.clearInterval(timer)
  }, [isRunning, visible])

  const idle = snapshot.idle.length > 1 ? snapshot.idle : [...snapshot.idle, ...PREVIEW_AVATARS]
  const avatar = running?.avatar ?? idle[rotation % idle.length]!
  return (
    <span aria-hidden="true" className="workspace-bot-rail-avatar" data-avatar-mode={isRunning ? 'running' : 'rotation'} data-avatar-id={avatar.id}>
      <AgentAvatar
        autoAdvance={false}
        color={avatar.color}
        interactive={false}
        paused={!visible}
        reducedMotion={reducedMotion}
        renderer="3d"
        shape={avatar.shape}
        size={32}
        state={running?.state ?? 'idle'}
        theme={theme ?? 'auto'}
      />
    </span>
  )
}
