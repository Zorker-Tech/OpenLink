'use client'

import {
  AgentAvatar,
  COLORS,
  SHAPES,
  type AgentAvatarHandle,
} from '@zorker/avatar'
import type { BotSummary } from '@/lib/bot-types'
import type { ConfiguredModelOption } from '@/lib/ai-provider-types'
import { WorkModelSelector, type WorkModelOption } from '@/components/work-model-selector'
import { ArrowRight, Check, LoaderCircle, Maximize2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

type BotOnboardingProps = {
  workspaceSlug: string
  workspaceName: string
  models: readonly ConfiguredModelOption[]
  firstBot: boolean
  theme: 'light' | 'dark'
  workHostReady?: boolean
  initialName?: string
  onCancel?: () => void
  onCreated: (bot: BotSummary) => void
}

type Phase = 'editing' | 'creating' | 'ready'

interface ScreenRect {
  left: number
  top: number
  width: number
  height: number
}

interface ShapeFlight {
  id: number
  incoming: {
    shape: string
    color: string
    from: ScreenRect
    stage: ScreenRect
    expressions: string[]
    playMs: number
  }
  outgoing: {
    shape: string
    color: string
    stage: ScreenRect
    to: ScreenRect
  } | null
}

const FLIGHT_EXPRESSIONS = ['happy', 'inspecting', 'surprised', 'calm', 'confused', 'squinted']

function screenRect(rect: DOMRect): ScreenRect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

/** Pick three distinct reactions and never repeat the previous selection's run. */
function pickFlightExpressions(previous: readonly string[]): string[] {
  let picked: string[] = []
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const pool = [...FLIGHT_EXPRESSIONS]
    picked = []
    while (picked.length < 3 && pool.length) {
      picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]!)
    }
    if (picked.join('|') !== previous.join('|')) return picked
  }
  return picked
}

function defaultModel(models: readonly ConfiguredModelOption[]) {
  return models.find((model) => model.isDefault) ?? models[0] ?? null
}

function modelOptions(models: readonly ConfiguredModelOption[]): WorkModelOption[] {
  return models.map((model) => ({
    id: model.id,
    label: model.name,
    description: model.providerName,
  }))
}

function friendlyError(code: string): string {
  const messages: Record<string, string> = {
    BOT_NAME_INVALID: 'Use a name between 1 and 64 characters.',
    BOT_DESCRIPTION_INVALID: 'The description is too long.',
    BOT_AVATAR_INVALID: 'The selected avatar could not be rendered.',
    BOT_AVATAR_TOO_LARGE: 'The avatar image is too large.',
    BOT_MODEL_REQUIRED: 'Choose an enabled model before creating the Bot.',
    BOT_WORKSPACE_NOT_FOUND: 'This workspace is no longer available.',
    BOT_CREATE_FAILED: 'Work Host could not create the Bot.',
    BOT_RUNTIME_NOT_READY: 'The Bot computer could not be initialized.',
    BOT_PROJECT_NOT_READY: 'The Bot project is not ready yet.',
    PI_SESSION_READ_FAILED: 'The Bot memory could not be read.',
    BOT_SUBSTRATE_NOT_CONFIGURED: 'The Bot execution substrate is not configured.',
    BOT_SUBSTRATE_UNAVAILABLE: 'The Bot execution substrate is not available yet.',
    BOT_RUNTIME_BUSY: 'The Bot computer is busy. Try again in a moment.',
    BOT_RUNTIME_UNAVAILABLE: 'The Bot computer is not available yet.',
    MODEL_CONFIGURATION_REQUIRED: 'Configure an AI provider for this Bot.',
    PROVIDER_API_KEY_REQUIRED: 'The selected provider needs an API key.',
    PROVIDER_CREDENTIAL_REKEY_REQUIRED: 'The selected provider credentials must be refreshed.',
    MODEL_NOT_ENABLED: 'The selected model is not enabled.',
    UNKNOWN_PROVIDER_MODEL: 'The selected model is no longer available.',
  }
  return messages[code] ?? code
}

export function BotOnboarding({
  workspaceSlug,
  workspaceName,
  models,
  firstBot,
  theme,
  workHostReady = true,
  initialName = '',
  onCancel,
  onCreated,
}: BotOnboardingProps) {
  const initialModel = defaultModel(models)
  const [name, setName] = useState(initialName)
  const [shape, setShape] = useState('blob')
  const [color, setColor] = useState('orange')
  const [modelId, setModelId] = useState(initialModel?.id ?? '')
  const [phase, setPhase] = useState<Phase>('editing')
  const [createdBot, setCreatedBot] = useState<BotSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const previewRef = useRef<AgentAvatarHandle>(null)
  const completeRef = useRef<AgentAvatarHandle>(null)
  const hiddenCompleteRef = useRef<AgentAvatarHandle>(null)
  const createdBotRef = useRef<BotSummary | null>(null)
  const createdNotifiedRef = useRef(false)
  const createdTimerRef = useRef<number | null>(null)
  const onCreatedRef = useRef(onCreated)
  const selectedModel = useMemo(
    () => models.find((model) => model.id === modelId) ?? null,
    [modelId, models],
  )
  const locked = createdBot !== null
  const shapeRailRef = useRef<HTMLDivElement>(null)
  const shapeScrollRef = useRef({ target: 0, current: 0, frame: 0 })
  const [shapeRailState, setShapeRailState] = useState({ overflow: false, atStart: true, atEnd: true })
  const [stageShape, setStageShape] = useState('blob')
  const [stageHidden, setStageHidden] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [flight, setFlight] = useState<ShapeFlight | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const shapeButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const pickerBackdropRef = useRef<HTMLDivElement>(null)
  const pickerDialogRef = useRef<HTMLDivElement>(null)
  const incomingRef = useRef<HTMLDivElement>(null)
  const outgoingRef = useRef<HTMLDivElement>(null)
  const incomingHandleRef = useRef<AgentAvatarHandle>(null)
  const outgoingHandleRef = useRef<AgentAvatarHandle>(null)
  const flightAnimationsRef = useRef<Animation[]>([])
  const flightTimersRef = useRef<number[]>([])
  const lastFlightExpressionsRef = useRef<string[]>([])
  const flightIdRef = useRef(0)

  const syncShapeRail = useCallback(() => {
    const rail = shapeRailRef.current
    if (!rail) return
    const max = Math.max(0, rail.scrollWidth - rail.clientWidth)
    setShapeRailState((previous) => {
      const next = {
        overflow: max > 1,
        atStart: rail.scrollLeft <= 1,
        atEnd: rail.scrollLeft >= max - 1,
      }
      return previous.overflow === next.overflow && previous.atStart === next.atStart && previous.atEnd === next.atEnd
        ? previous
        : next
    })
  }, [])

  const handleShapeScroll = useCallback(() => {
    const rail = shapeRailRef.current
    if (!rail) return
    const scroll = shapeScrollRef.current
    // A native scroll (trackpad, touch, or scrollbar) is authoritative unless
    // the wheel animation is currently driving the rail.
    if (!scroll.frame) {
      scroll.current = rail.scrollLeft
      scroll.target = rail.scrollLeft
    }
    syncShapeRail()
  }, [syncShapeRail])

  const handleShapeWheel = useCallback((event: globalThis.WheelEvent) => {
    const rail = shapeRailRef.current
    if (!rail) return
    const max = Math.max(0, rail.scrollWidth - rail.clientWidth)
    if (max <= 1) return
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
    if (!delta) return
    // Keep the page still while the pointer is over the rail, then ease the
    // rail toward the accumulated wheel target instead of jumping per event.
    event.preventDefault()
    const scroll = shapeScrollRef.current
    scroll.target = Math.max(0, Math.min(max, scroll.target + delta * 1.15))
    if (scroll.frame) return
    const animate = () => {
      const activeRail = shapeRailRef.current
      if (!activeRail) {
        scroll.frame = 0
        return
      }
      const distance = scroll.target - scroll.current
      if (Math.abs(distance) < 0.5) {
        scroll.current = scroll.target
        activeRail.scrollLeft = scroll.current
        scroll.frame = 0
        syncShapeRail()
        return
      }
      scroll.current += distance * 0.18
      activeRail.scrollLeft = scroll.current
      scroll.frame = requestAnimationFrame(animate)
    }
    scroll.frame = requestAnimationFrame(animate)
  }, [syncShapeRail])

  useEffect(() => {
    const rail = shapeRailRef.current
    if (!rail) return
    // React registers wheel listeners passively, which cannot stop the page
    // from scrolling while the pointer is over the rail.
    rail.addEventListener('wheel', handleShapeWheel, { passive: false })
    return () => rail.removeEventListener('wheel', handleShapeWheel)
  }, [handleShapeWheel])

  useEffect(() => {
    const rail = shapeRailRef.current
    if (!rail) return
    syncShapeRail()
    const observer = new ResizeObserver(syncShapeRail)
    observer.observe(rail)
    return () => observer.disconnect()
  }, [syncShapeRail])

  useEffect(() => () => {
    const scroll = shapeScrollRef.current
    if (scroll.frame) cancelAnimationFrame(scroll.frame)
  }, [])

  const clearFlightResources = useCallback(() => {
    for (const animation of flightAnimationsRef.current) {
      try { animation.cancel() } catch {}
    }
    flightAnimationsRef.current = []
    for (const timer of flightTimersRef.current) window.clearTimeout(timer)
    flightTimersRef.current = []
  }, [])

  const cancelShapeFlight = useCallback(() => {
    clearFlightResources()
    setFlight(null)
    setStageHidden(false)
  }, [clearFlightResources])

  useEffect(() => () => clearFlightResources(), [clearFlightResources])

  const chooseShape = useCallback((nextShape: string, button: HTMLButtonElement | null) => {
    if (locked || phase !== 'editing' || nextShape === shape) return
    setShape(nextShape)
    if (nextShape === stageShape) {
      cancelShapeFlight()
      setStageShape(nextShape)
      return
    }
    const stageElement = stageRef.current
    if (!stageElement || !button) {
      setStageShape(nextShape)
      return
    }
    const stage = screenRect(stageElement.getBoundingClientRect())
    const from = screenRect(button.getBoundingClientRect())
    if (stage.width < 80 || stage.height < 80 || from.width < 8) {
      setStageShape(nextShape)
      return
    }
    cancelShapeFlight()
    const expressions = pickFlightExpressions(lastFlightExpressionsRef.current)
    lastFlightExpressionsRef.current = expressions
    flightIdRef.current += 1
    setStageHidden(true)
    const previousButton = shapeButtonRefs.current.get(stageShape)
    const previousRect = previousButton ? screenRect(previousButton.getBoundingClientRect()) : from
    const railRect = shapeRailRef.current?.getBoundingClientRect()
    // The rail scrolls horizontally, so the previous form's slot can be outside
    // the visible strip. Return to the nearest visible edge instead of flying
    // the outgoing form off-screen.
    const outgoingTarget = railRect
      ? {
          ...previousRect,
          left: Math.max(railRect.left, Math.min(railRect.right - previousRect.width, previousRect.left)),
        }
      : previousRect
    setFlight({
      id: flightIdRef.current,
      incoming: {
        shape: nextShape,
        color,
        from,
        stage,
        expressions,
        playMs: 1_400 + Math.round(Math.random() * 1_200),
      },
      outgoing: stageShape !== nextShape
        ? { shape: stageShape, color, stage, to: outgoingTarget }
        : null,
    })
  }, [cancelShapeFlight, color, locked, phase, shape, stageShape])

  useEffect(() => {
    if (!flight) return
    const incomingElement = incomingRef.current
    if (!incomingElement) return
    const stage = flight.incoming.stage
    const size = Math.max(240, Math.round(stage.width))
    const startScale = Math.max(0.08, flight.incoming.from.width / size)
    const fromX = flight.incoming.from.left + flight.incoming.from.width / 2 - size / 2
    const fromY = flight.incoming.from.top + flight.incoming.from.height / 2 - size / 2
    const stageX = stage.left + stage.width / 2 - size / 2
    const stageY = stage.top + stage.height / 2 - size / 2
    const playScale = Math.min(0.44, Math.max(0.3, startScale + 0.28))
    const railRight = shapeRailRef.current?.getBoundingClientRect().right
      ?? flight.incoming.from.left + flight.incoming.from.width
    // The form column has no free space around the rail; let the selected form
    // step out into the margin beside it, then arc over the form to the stage.
    const playCenterX = Math.min(
      window.innerWidth - (size * playScale) / 2 - 16,
      railRight + 100,
    )
    const playX = playCenterX - size / 2
    const playY = fromY - 20
    const liftX = fromX + (stageX - fromX) * 0.55
    const liftY = Math.max(48, Math.min(fromY, stageY) - 170)
    const playMs = flight.incoming.playMs
    const flyMs = 900
    const totalMs = playMs + flyMs
    const flyStart = playMs / totalMs
    const popScale = playScale
    const settleOffset = Math.max(0.28, Math.min(0.42, flyStart * 0.5))
    const floatOffset = Math.max(settleOffset + 0.08, flyStart * 0.82)
    const liftOffset = Math.min(0.9, flyStart + (1 - flyStart) * 0.4)

    const incomingKeyframes: Keyframe[] = [
      {
        offset: 0,
        opacity: 1,
        transform: `translate3d(${fromX}px, ${fromY}px, 0) scale(${startScale}) rotateX(0deg) rotateY(0deg) rotateZ(0deg)`,
        easing: 'cubic-bezier(.2,.86,.28,1.12)',
      },
      {
        offset: 0.14,
        opacity: 1,
        transform: `translate3d(${fromX}px, ${fromY - 52}px, 0) scale(${popScale}) rotateX(-12deg) rotateY(22deg) rotateZ(-6deg)`,
        easing: 'cubic-bezier(.3,.7,.3,1)',
      },
      {
        offset: settleOffset,
        opacity: 1,
        transform: `translate3d(${playX}px, ${playY}px, 0) scale(${playScale}) rotateX(6deg) rotateY(-14deg) rotateZ(3deg)`,
        easing: 'cubic-bezier(.4,0,.3,1)',
      },
      {
        offset: floatOffset,
        opacity: 1,
        transform: `translate3d(${playX - 12}px, ${playY - 10}px, 0) scale(${Math.max(0.28, playScale - 0.02)}) rotateX(-4deg) rotateY(12deg) rotateZ(-2deg)`,
        easing: 'cubic-bezier(.4,0,.2,1)',
      },
      {
        offset: liftOffset,
        opacity: 1,
        transform: `translate3d(${liftX}px, ${liftY}px, 0) scale(0.72) rotateX(0deg) rotateY(-6deg) rotateZ(0deg)`,
        easing: 'cubic-bezier(.3,.7,.2,1)',
      },
      {
        offset: 0.94,
        opacity: 1,
        transform: `translate3d(${stageX}px, ${stageY}px, 0) scale(1.02) rotateX(0deg) rotateY(0deg) rotateZ(0deg)`,
        easing: 'cubic-bezier(.3,.8,.2,1)',
      },
      {
        offset: 1,
        opacity: 0.12,
        transform: `translate3d(${stageX}px, ${stageY}px, 0) scale(1) rotateX(0deg) rotateY(0deg) rotateZ(0deg)`,
      },
    ]
    incomingElement.style.opacity = '1'
    const incomingAnimation = incomingElement.animate(incomingKeyframes, {
      duration: totalMs,
      fill: 'forwards',
    })
    flightAnimationsRef.current.push(incomingAnimation)

    const outgoingElement = outgoingRef.current
    if (outgoingElement && flight.outgoing) {
      const toX = flight.outgoing.to.left + flight.outgoing.to.width / 2 - size / 2
      const toY = flight.outgoing.to.top + flight.outgoing.to.height / 2 - size / 2
      const endScale = Math.max(0.08, flight.outgoing.to.width / size)
      const outgoingKeyframes: Keyframe[] = [
        {
          offset: 0,
          opacity: 0,
          transform: `translate3d(${stageX}px, ${stageY}px, 0) scale(1) rotateZ(0deg)`,
          easing: 'cubic-bezier(.3,.7,.3,1)',
        },
        {
          offset: 0.2,
          opacity: 1,
          transform: `translate3d(${stageX}px, ${stageY}px, 0) scale(1) rotateZ(0deg)`,
        },
        {
          offset: 0.3,
          opacity: 1,
          transform: `translate3d(${stageX}px, ${stageY - 12}px, 0) scale(1.08, 0.8) rotateZ(-4deg)`,
          easing: 'cubic-bezier(.4,0,.2,1)',
        },
        {
          offset: 0.6,
          opacity: 0.95,
          transform: `translate3d(${stageX + (toX - stageX) * 0.45}px, ${stageY + (toY - stageY) * 0.45}px, 0) scale(0.68) rotateZ(6deg)`,
          easing: 'cubic-bezier(.4,0,.2,1)',
        },
        {
          offset: 1,
          opacity: 0.14,
          transform: `translate3d(${toX}px, ${toY}px, 0) scale(${endScale}) rotateZ(14deg)`,
        },
      ]
      outgoingElement.style.opacity = '1'
      const outgoingAnimation = outgoingElement.animate(outgoingKeyframes, {
        duration: 920,
        fill: 'forwards',
      })
      flightAnimationsRef.current.push(outgoingAnimation)
    }

    const [firstState, secondState, thirdState] = flight.incoming.expressions
    flightTimersRef.current.push(window.setTimeout(() => {
      incomingHandleRef.current?.setExpression(firstState)
      outgoingHandleRef.current?.setExpression('surprised')
    }, 120))
    flightTimersRef.current.push(window.setTimeout(() => {
      incomingHandleRef.current?.setExpression(secondState)
    }, 220 + playMs * 0.34))
    flightTimersRef.current.push(window.setTimeout(() => {
      incomingHandleRef.current?.setExpression(thirdState)
    }, 220 + playMs * 0.68))
    flightTimersRef.current.push(window.setTimeout(() => {
      outgoingHandleRef.current?.setExpression('squinted')
    }, 420))
    flightTimersRef.current.push(window.setTimeout(() => {
      // Commit the new form while the overlay still covers the stage so the
      // real 3D form is already morphed when the crossfade reveals it.
      setStageShape(flight.incoming.shape)
    }, totalMs - 420))
    flightTimersRef.current.push(window.setTimeout(() => {
      setStageHidden(false)
      setFlight(null)
      window.requestAnimationFrame(() => {
        stageRef.current?.animate([
          { transform: 'scale(0.96)', opacity: 0.65 },
          { transform: 'scale(1.035)', opacity: 1, offset: 0.55 },
          { transform: 'scale(1)', opacity: 1 },
        ], { duration: 560, easing: 'cubic-bezier(.2,.8,.2,1)' })
      })
    }, totalMs + 30))

    return () => {
      clearFlightResources()
    }
  }, [clearFlightResources, flight])

  const openShapePicker = useCallback(() => {
    if (locked || phase !== 'editing') return
    cancelShapeFlight()
    setStageShape(shape)
    setPickerOpen(true)
  }, [cancelShapeFlight, locked, phase, shape])

  const chooseShapeFromPicker = useCallback((nextShape: string) => {
    if (locked || phase !== 'editing') return
    setShape(nextShape)
    setStageShape(nextShape)
  }, [locked, phase])

  useEffect(() => {
    if (!pickerOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPickerOpen(false)
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    pickerBackdropRef.current?.animate([
      { opacity: 0 },
      { opacity: 1 },
    ], { duration: 200, easing: 'ease-out', fill: 'both' })
    pickerDialogRef.current?.animate([
      { opacity: 0, transform: 'translateY(16px) scale(0.94)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' },
    ], { duration: 360, easing: 'cubic-bezier(.2,.85,.25,1.04)', fill: 'both' })
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [pickerOpen])

  const shapeFade = 18
  const shapeMask = !shapeRailState.overflow
    ? undefined
    : shapeRailState.atStart
      ? `linear-gradient(to right, black 0, black calc(100% - ${shapeFade}px), transparent 100%)`
      : shapeRailState.atEnd
        ? `linear-gradient(to right, transparent 0, black ${shapeFade}px, black 100%)`
        : `linear-gradient(to right, transparent 0, black ${shapeFade}px, black calc(100% - ${shapeFade}px), transparent 100%)`

  useEffect(() => {
    onCreatedRef.current = onCreated
  }, [onCreated])

  useEffect(() => () => {
    if (createdTimerRef.current !== null) window.clearTimeout(createdTimerRef.current)
  }, [])

  const rememberCreated = (bot: BotSummary) => {
    createdBotRef.current = bot
    setCreatedBot(bot)
  }

  const notifyCreated = useCallback((bot: BotSummary) => {
    if (createdNotifiedRef.current) return
    createdNotifiedRef.current = true
    if (createdTimerRef.current !== null) {
      window.clearTimeout(createdTimerRef.current)
      createdTimerRef.current = null
    }
    onCreatedRef.current(bot)
  }, [])

  const scheduleCreated = useCallback((bot: BotSummary) => {
    if (createdTimerRef.current !== null) window.clearTimeout(createdTimerRef.current)
    createdTimerRef.current = window.setTimeout(() => {
      createdTimerRef.current = null
      notifyCreated(bot)
    }, 900)
  }, [notifyCreated])

  useEffect(() => {
    if (phase !== 'creating') return
    let frame = 0
    let yaw = 0
    let last = performance.now()
    const tick = (now: number) => {
      const delta = Math.min(64, Math.max(0, now - last))
      last = now
      yaw = (yaw + delta * 0.11) % 360
      previewRef.current?.setView({ yaw })
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [phase])

  const warm = async (bot: BotSummary) => {
    const response = await fetch(`/api/bots/${encodeURIComponent(bot.id)}/warm`, {
      method: 'POST',
      cache: 'no-store',
    })
    const payload = await response.json().catch(() => null) as {
      ready?: unknown
      error?: { message?: string }
    } | null
    if (!response.ok || payload?.ready !== true) {
      throw new Error(friendlyError(payload?.error?.message || 'BOT_RUNTIME_UNAVAILABLE'))
    }
    return {
      ...bot,
      runtimeStatus: 'ready' as const,
      runtimeReadyAt: new Date().toISOString(),
      runtimeLastError: null,
      runtimeCheckedAt: new Date().toISOString(),
    }
  }

  const create = async () => {
    const trimmed = name.trim()
    if (!createdBot && !trimmed) {
      setError('Give your Bot a name.')
      return
    }
    if (!createdBot && !selectedModel) {
      setError('Choose a model first.')
      return
    }
    setError(null)
    if (flight) {
      cancelShapeFlight()
      setStageShape(shape)
    }
    setPhase('creating')
    previewRef.current?.setState('spawning')
    let bot = createdBotRef.current
    try {
      if (!bot) {
        let png = ''
        for (let attempt = 0; attempt < 20 && !png; attempt += 1) {
          png = await (hiddenCompleteRef.current?.getPngDataUrl(640)
            ?? completeRef.current?.getPngDataUrl(640)
            ?? Promise.resolve(''))
          if (!png) await new Promise<void>((resolve) => window.setTimeout(resolve, 50))
        }
        const response = await fetch('/api/bots', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceSlug,
            name: trimmed,
            description: 'A persistent Bot that works in its own isolated computer.',
            avatarShape: shape,
            avatarColor: color,
            avatarPngBase64: png ? png.replace(/^data:image\/png;base64,/, '') : undefined,
            model: {
              providerId: selectedModel!.providerId,
              modelId: selectedModel!.modelId,
            },
          }),
        })
        const payload = await response.json().catch(() => null) as { bot?: BotSummary; error?: { message?: string } } | null
        if (!response.ok || !payload?.bot) {
          throw new Error(friendlyError(payload?.error?.message || 'BOT_CREATE_FAILED'))
        }
        bot = payload.bot
        rememberCreated(bot)
      }
      bot = await warm(bot)
      rememberCreated(bot)
      setPhase('ready')
      previewRef.current?.setState('finished')
      scheduleCreated(bot)
    } catch (createError) {
      setPhase('editing')
      previewRef.current?.setState(bot ? 'idle' : 'failed')
      setError(createError instanceof Error ? friendlyError(createError.message) : 'The Bot could not be created.')
    }
  }

  const ready = phase === 'ready'
  const selectedShapeLabel = SHAPES.find((option) => option.id === shape)?.label ?? shape
  const flightSize = flight ? Math.max(240, Math.round(flight.incoming.stage.width)) : 0
  const flightStartScale = flight && flightSize
    ? Math.max(0.08, flight.incoming.from.width / flightSize)
    : 0.2
  const flightIncomingStart = flight && flightSize
    ? `translate3d(${flight.incoming.from.left + flight.incoming.from.width / 2 - flightSize / 2}px, ${flight.incoming.from.top + flight.incoming.from.height / 2 - flightSize / 2}px, 0) scale(${flightStartScale})`
    : undefined
  const flightOutgoingStart = flight && flightSize
    ? `translate3d(${flight.incoming.stage.left + flight.incoming.stage.width / 2 - flightSize / 2}px, ${flight.incoming.stage.top + flight.incoming.stage.height / 2 - flightSize / 2}px, 0) scale(1)`
    : undefined

  return (
    <div className="bot-onboarding onboarding-entrance flex min-h-dvh flex-col bg-[var(--app-background)] text-[var(--app-foreground)]">
      {!firstBot && onCancel ? (
        <header className="flex h-14 shrink-0 items-center justify-between px-5 md:px-8">
          <div className="flex min-w-0 items-center gap-2.5">
            <span aria-hidden="true" className="grid size-7 place-items-center rounded-lg bg-[var(--app-active)]">
              <img alt="" className="size-4" src="/openlink/navigation/bot.svg" />
            </span>
            <span className="truncate text-[13px] font-medium tracking-[-0.08px]">{workspaceName}</span>
            <span className="text-[13px] text-[var(--app-subtle-foreground)]">/</span>
            <span className="text-[13px] text-[var(--app-muted)]">Bots</span>
          </div>
          <button
            aria-label="Cancel"
            className="grid size-8 place-items-center rounded-lg text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]"
            onClick={() => {
              if (phase === 'creating') return
              const bot = createdBotRef.current
              if (bot) notifyCreated(bot)
              else onCancel()
            }}
            type="button"
          >
            <X className="size-4" />
          </button>
        </header>
      ) : null}

      <main className="mx-auto grid w-full max-w-[1120px] flex-1 grid-cols-1 items-center gap-8 px-5 pb-10 md:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)] md:px-10 lg:gap-16">
        <section aria-label="Bot preview" className="relative flex min-h-[340px] items-center justify-center md:min-h-[560px]">
          <div className="pointer-events-none absolute inset-x-[16%] bottom-[12%] h-24 rounded-full bg-[var(--app-brand)] opacity-[0.06] blur-3xl" />
          <div
            className="relative grid place-items-center transition-opacity duration-200"
            ref={stageRef}
            style={{ opacity: stageHidden ? 0 : 1 }}
          >
            {ready ? (
              <AgentAvatar
                ref={completeRef}
                clickAction="bounce"
                color={color}
                followPointer
                hoverTilt
                renderer="complete"
                shape={stageShape}
                size="min(360px, 78vw)"
                state="finished"
                theme={theme}
              />
            ) : (
              <AgentAvatar
                ref={previewRef}
                clickAction="bounce"
                color={color}
                draggable
                followPointer
                hoverTilt
                interactive
                renderer="3d"
                shape={stageShape}
                size="min(360px, 78vw)"
                state={phase === 'creating' ? 'spawning' : 'idle'}
                theme={theme}
              />
            )}
            <div className="pointer-events-none absolute -bottom-7 left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] tracking-[0.01em] text-[var(--app-subtle-foreground)]">
              {ready ? 'Bot initialized' : phase === 'creating' ? 'Initializing computer…' : 'Drag to rotate'}
            </div>
            <div aria-hidden="true" className="pointer-events-none fixed -left-[2000px] top-0 size-[512px] opacity-0">
              <AgentAvatar
                ref={hiddenCompleteRef}
                color={color}
                renderer="complete"
                shape={stageShape}
                size={512}
                state="finished"
                theme={theme}
              />
            </div>
          </div>
        </section>

        <section className="w-full max-w-[460px] justify-self-center md:justify-self-start">
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--app-subtle-foreground)]">
            {firstBot ? 'Your first Bot' : 'New Bot'}
          </p>
          <h1 className="mt-3 text-[30px] font-medium leading-[1.1] tracking-[-0.045em] md:text-[36px]">
            {ready ? 'Ready to work.' : 'Give it a name and a face.'}
          </h1>
          <p className="mt-3 max-w-[400px] text-[13px] leading-5 text-[var(--app-muted)]">
            Every Bot gets its own persistent memory, transcript, and isolated computer inside your Ubuntu workspace.
          </p>

          <div className="mt-7 space-y-6">
            <label className="block">
              <span className="mb-2 block text-[12px] font-medium text-[var(--app-muted)]">Name</span>
              <input
                autoFocus
                className="h-11 w-full rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3.5 text-[15px] outline-none transition-colors placeholder:text-[var(--app-subtle-foreground)] focus:border-[var(--app-focus-ring)]"
                disabled={phase !== 'editing' || locked}
                maxLength={64}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Chief, Scout, Operator"
                value={name}
              />
            </label>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[12px] font-medium text-[var(--app-muted)]">Form</span>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[var(--app-subtle-foreground)]">{shape}</span>
                  <button
                    aria-label="Expand avatar picker"
                    className="grid size-6 place-items-center rounded-md text-[var(--app-subtle-foreground)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)] disabled:pointer-events-none disabled:opacity-40"
                    disabled={phase !== 'editing' || locked}
                    onClick={openShapePicker}
                    title="Expand"
                    type="button"
                  >
                    <Maximize2 className="size-3.5" />
                  </button>
                </div>
              </div>
              <div className="min-w-[148px] rounded-xl border border-[var(--app-border)] bg-[var(--app-surface)] p-2">
                <div
                  aria-label="Avatar form"
                  className="flex touch-pan-x gap-1.5 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                  onScroll={handleShapeScroll}
                  ref={shapeRailRef}
                  style={{ maskImage: shapeMask, WebkitMaskImage: shapeMask }}
                >
                  {SHAPES.map((option) => (
                    <button
                      aria-label={option.label}
                      aria-pressed={shape === option.id}
                      className={`grid size-10 shrink-0 place-items-center rounded-lg transition-colors ${stageShape === option.id ? 'bg-[var(--app-selected)]' : shape === option.id ? 'bg-[var(--app-hover)] ring-1 ring-[var(--app-focus-ring)]' : 'hover:bg-[var(--app-hover)]'}`}
                      disabled={phase !== 'editing' || locked}
                      key={option.id}
                      onClick={(event) => chooseShape(option.id, event.currentTarget)}
                      ref={(element) => {
                        if (element) shapeButtonRefs.current.set(option.id, element)
                        else shapeButtonRefs.current.delete(option.id)
                      }}
                      title={option.label}
                      type="button"
                    >
                      <AgentAvatar
                        color={color}
                        renderer="svg"
                        shape={option.id}
                        size={30}
                        state="idle"
                        theme={theme}
                      />
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div>
              <span className="mb-2 block text-[12px] font-medium text-[var(--app-muted)]">Color</span>
              <div className="flex flex-wrap gap-2">
                {COLORS.map((option) => (
                  <button
                    aria-label={option.label}
                    aria-pressed={color === option.id}
                    className={`grid size-8 place-items-center rounded-full transition-transform ${color === option.id ? 'scale-110 ring-2 ring-[var(--app-foreground)] ring-offset-2 ring-offset-[var(--app-background)]' : 'hover:scale-105'}`}
                    disabled={phase !== 'editing' || locked}
                    key={option.id}
                    onClick={() => setColor(option.id)}
                    style={{ background: option.swatch }}
                    title={option.label}
                    type="button"
                  >
                    {color === option.id ? <Check className="size-3.5 text-white mix-blend-difference" /> : null}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="mb-2 block text-[12px] font-medium text-[var(--app-muted)]">Model</span>
              {models.length ? (
                <WorkModelSelector
                  className="h-10! w-full! justify-between! rounded-xl! border-[var(--app-control-border)]! bg-[var(--app-surface)]! px-3.5! text-[13px]!"
                  disabled={phase !== 'editing' || locked}
                  initialView="models"
                  models={modelOptions(models)}
                  onValueChange={(next) => setModelId(next.modelId)}
                  value={{ modelId }}
                />
              ) : (
                <a
                  className="flex h-10 items-center justify-between rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3.5 text-[13px] text-[var(--app-muted)] hover:bg-[var(--app-hover)]"
                  href="/settings/ai-providers"
                >
                  Configure an AI provider
                  <ArrowRight className="size-4" />
                </a>
              )}
            </div>
          </div>

          {!workHostReady ? (
            <p className="mt-4 rounded-xl border border-[var(--app-warning-surface)] bg-[var(--app-warning-surface)] px-3 py-2 text-[12px] leading-5 text-[var(--app-warning)]" role="alert">
              Work Host is not running. Start the OpenLink runtime so the Bot can be created.
            </p>
          ) : null}
          {error ? <p className="mt-4 text-[12px] leading-5 text-[var(--app-danger)]" role="alert">{error}</p> : null}

          <div className="mt-7 flex items-center gap-3">
            <button
              className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--app-submit-background)] px-4 text-[13px] font-medium text-[var(--app-submit-foreground)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
              disabled={phase !== 'editing' || !models.length || !workHostReady}
              onClick={() => void create()}
              type="button"
            >
              {phase === 'creating' ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {phase === 'creating' ? 'Initializing Bot' : ready ? 'Opening Bot' : locked ? 'Retry initialization' : 'Create Bot'}
              {phase === 'editing' ? <ArrowRight className="size-4" /> : null}
            </button>
            {locked && phase === 'editing' && createdBot ? (
              <button
                className="h-11 rounded-xl px-4 text-[13px] text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]"
                onClick={() => notifyCreated(createdBot)}
                type="button"
              >
                Open Bot
              </button>
            ) : null}
            {!firstBot && onCancel ? (
              <button
                className="h-11 rounded-xl px-4 text-[13px] text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]"
                disabled={phase !== 'editing' || locked}
                onClick={onCancel}
                type="button"
              >
                Cancel
              </button>
            ) : null}
          </div>
          <p className="mt-3 text-[11px] leading-4 text-[var(--app-subtle-foreground)]">
            The 3D form is used while choosing. Your Bot uses its complete form across the workspace.
          </p>
        </section>
      </main>
      {flight && typeof document !== 'undefined' ? createPortal(
        <>
          {flight.outgoing ? (
            <div
              aria-hidden="true"
              className="pointer-events-none fixed left-0 top-0 z-[90] origin-center"
              ref={outgoingRef}
              style={{ height: flightSize, transform: flightOutgoingStart, width: flightSize }}
            >
              <AgentAvatar
                ref={outgoingHandleRef}
                color={flight.outgoing.color}
                renderer="complete"
                shape={flight.outgoing.shape}
                size={flightSize}
                state="idle"
                theme={theme}
              />
            </div>
          ) : null}
          <div
            aria-hidden="true"
            className="pointer-events-none fixed left-0 top-0 z-[91] origin-center"
            ref={incomingRef}
            style={{ height: flightSize, transform: flightIncomingStart, width: flightSize }}
          >
            <AgentAvatar
              ref={incomingHandleRef}
              color={flight.incoming.color}
              renderer="complete"
              shape={flight.incoming.shape}
              size={flightSize}
              state="idle"
              theme={theme}
            />
          </div>
        </>,
        document.body,
      ) : null}
      {pickerOpen && typeof document !== 'undefined' ? createPortal(
        <div
          className="fixed inset-0 z-[100] grid place-items-center bg-black/55 p-4 backdrop-blur-md"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPickerOpen(false)
          }}
          ref={pickerBackdropRef}
        >
          <div
            aria-label="Avatar picker"
            aria-modal="true"
            className="relative grid h-[92vh] w-[94vw] grid-rows-[minmax(0,0.85fr)_minmax(0,1.15fr)] overflow-hidden rounded-[26px] border border-[var(--app-border)] bg-[var(--app-surface)] shadow-[0_36px_120px_rgba(0,0,0,0.5)] md:h-[min(660px,88vh,58.75vw)] md:w-[min(1056px,94vw,140.8vh)] md:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] md:grid-rows-1"
            ref={pickerDialogRef}
            role="dialog"
          >
            <button
              aria-label="Close avatar picker"
              autoFocus
              className="absolute right-3 top-3 z-10 grid size-8 place-items-center rounded-full bg-[var(--app-surface)] text-[var(--app-muted)] shadow-[0_2px_12px_rgba(0,0,0,0.18)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]"
              onClick={() => setPickerOpen(false)}
              type="button"
            >
              <X className="size-4" />
            </button>

            <section className="relative flex min-h-0 flex-col items-center justify-center overflow-hidden border-b border-[var(--app-border)] bg-[radial-gradient(circle_at_50%_46%,var(--app-active),transparent_68%)] md:border-b-0 md:border-r">
              <div className="pointer-events-none absolute inset-x-[18%] bottom-[16%] h-24 rounded-full bg-[var(--app-brand)] opacity-[0.07] blur-3xl" />
              <div className="relative grid place-items-center">
                <AgentAvatar
                  color={color}
                  draggable
                  followPointer
                  hoverTilt
                  interactive
                  renderer="3d"
                  shape={shape}
                  size="min(400px, 78vw, 40vh)"
                  state="idle"
                  theme={theme}
                />
              </div>
              <div className="pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-[var(--app-surface)] px-3 py-1 text-[11px] tracking-[0.01em] text-[var(--app-subtle-foreground)] shadow-[inset_0_0_0_1px_var(--app-border)]">
                3D form · {selectedShapeLabel}
              </div>
            </section>

            <section className="flex min-h-0 flex-col gap-3 overflow-hidden p-5 md:p-7">
              <div className="flex items-end justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--app-subtle-foreground)]">Complete form</p>
                  <h2 className="mt-1 truncate text-[22px] font-medium tracking-[-0.03em]">{selectedShapeLabel}</h2>
                </div>
                <span className="shrink-0 rounded-full bg-[var(--app-active)] px-2.5 py-1 text-[10px] text-[var(--app-subtle-foreground)]">{SHAPES.length} forms</span>
              </div>

              <div className="relative grid min-h-0 flex-1 place-items-center overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-background)]">
                <AgentAvatar
                  color={color}
                  renderer="complete"
                  shape={shape}
                  size="min(150px, 22vh)"
                  state="finished"
                  theme={theme}
                />
              </div>

              <div className="grid grid-cols-6 gap-1.5">
                {SHAPES.map((option) => (
                  <button
                    aria-label={option.label}
                    aria-pressed={shape === option.id}
                    className={`grid aspect-square place-items-center rounded-lg transition-colors ${shape === option.id ? 'bg-[var(--app-selected)]' : 'hover:bg-[var(--app-hover)]'}`}
                    key={option.id}
                    onClick={() => chooseShapeFromPicker(option.id)}
                    title={option.label}
                    type="button"
                  >
                    <AgentAvatar
                      color={color}
                      renderer="complete"
                      shape={option.id}
                      size={38}
                      state="idle"
                      theme={theme}
                    />
                  </button>
                ))}
              </div>
            </section>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  )
}
