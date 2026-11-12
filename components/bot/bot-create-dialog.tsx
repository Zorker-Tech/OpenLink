'use client'

import {
  AgentAvatar,
  COLORS,
  SHAPES,
  hashColor,
  hashShape,
  type AgentAvatarHandle,
} from '@zorker/avatar'
import { WorkModelSelector, type WorkModelOption } from '@/components/work-model-selector'
import type { ConfiguredModelOption } from '@/lib/ai-provider-types'
import type { BotSummary } from '@/lib/bot-types'
import { ArrowLeft, ArrowRight, Check, LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

type BotCreateDialogProps = {
  workspaceSlug: string
  models: readonly ConfiguredModelOption[]
  initialName: string
  theme: 'light' | 'dark'
  workHostReady?: boolean
  onBack: () => void
  onClose: () => void
  onCreated: (bot: BotSummary) => void
}

type Phase = 'editing' | 'creating' | 'ready'

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
    AGENT_HOST_NOT_CONFIGURED: 'The Bot runtime is not running. Start the OpenLink Agent Host.',
    BOT_RUNTIME_UNAVAILABLE: 'The Bot computer is not available yet.',
    MODEL_CONFIGURATION_REQUIRED: 'Configure an AI provider for this Bot.',
    PROVIDER_API_KEY_REQUIRED: 'The selected provider needs an API key.',
    PROVIDER_CREDENTIAL_REKEY_REQUIRED: 'The selected provider credentials must be refreshed.',
    MODEL_NOT_ENABLED: 'The selected model is not enabled.',
    UNKNOWN_PROVIDER_MODEL: 'The selected model is no longer available.',
  }
  return messages[code] ?? code
}

export function BotCreateDialog({
  workspaceSlug,
  models,
  initialName,
  theme,
  workHostReady = true,
  onBack,
  onClose,
  onCreated,
}: BotCreateDialogProps) {
  const defaultModel = models.find((model) => model.isDefault) ?? models[0] ?? null
  const seed = initialName.trim() || 'New Bot'
  const [name, setName] = useState(initialName)
  const [shape, setShape] = useState(hashShape(seed))
  const [color, setColor] = useState(hashColor(seed))
  const [modelId, setModelId] = useState(defaultModel?.id ?? '')
  const [phase, setPhase] = useState<Phase>('editing')
  const [createdBot, setCreatedBot] = useState<BotSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const previewRef = useRef<AgentAvatarHandle>(null)
  const hiddenCompleteRef = useRef<AgentAvatarHandle>(null)
  const completeRef = useRef<AgentAvatarHandle>(null)
  const createdBotRef = useRef<BotSummary | null>(null)
  const createdNotifiedRef = useRef(false)
  const createdTimerRef = useRef<number | null>(null)
  const onCreatedRef = useRef(onCreated)
  const selectedModel = models.find((model) => model.id === modelId) ?? null
  const ready = phase === 'ready'
  const locked = createdBot !== null

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
    }, 650)
  }, [notifyCreated])

  const closeDialog = () => {
    if (phase === 'creating') return
    const bot = createdBotRef.current
    if (bot) notifyCreated(bot)
    else onClose()
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || phase !== 'editing') return
      const bot = createdBotRef.current
      if (bot) notifyCreated(bot)
      else onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [notifyCreated, onClose, phase])

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
      runtimeSessionId?: unknown
      error?: { message?: string }
    } | null
    if (!response.ok || payload?.ready !== true) {
      throw new Error(friendlyError(payload?.error?.message || 'BOT_RUNTIME_UNAVAILABLE'))
    }
    return {
      ...bot,
      runtimeSessionId: typeof payload.runtimeSessionId === 'string' ? payload.runtimeSessionId : bot.runtimeSessionId,
      runtimeStatus: 'ready' as const,
      runtimeReadyAt: new Date().toISOString(),
      runtimeLastError: null,
      runtimeCheckedAt: new Date().toISOString(),
    }
  }

  const create = async () => {
    const trimmed = name.trim()
    if (!workHostReady) {
      setError('Work Host is not running. Start the OpenLink runtime so the Bot can be created.')
      return
    }
    if (!createdBot && !trimmed) {
      setError('Give your Bot a name.')
      return
    }
    if (!createdBot && !selectedModel) {
      setError('Choose a model first.')
      return
    }
    setError(null)
    setPhase('creating')
    previewRef.current?.setState('spawning')
    let bot = createdBotRef.current
    try {
      if (!bot) {
        let png = ''
        for (let attempt = 0; attempt < 20 && !png; attempt += 1) {
          png = await (hiddenCompleteRef.current?.getPngDataUrl(512)
            ?? completeRef.current?.getPngDataUrl(512)
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
            model: { providerId: selectedModel!.providerId, modelId: selectedModel!.modelId },
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

  return (
    <div className="zbd-app-palette-layer">
      <button
        aria-label="Close create Bot"
        className="zbd-app-palette-scrim"
        onClick={closeDialog}
        type="button"
      />
      <div
        aria-label="Create a Bot"
        aria-modal="true"
        className="zbd-app-palette zbd-app-create-palette"
        role="dialog"
      >
        <div className="zbd-app-palette-search">
          <button
            aria-label="Back to search"
            className="zbd-app-create-back"
            disabled={phase !== 'editing' || locked}
            onClick={onBack}
            type="button"
          >
            <ArrowLeft size={15} />
          </button>
          <span className="zbd-app-palette-to">New Bot</span>
          <span className="zbd-app-create-step">{ready ? 'Ready' : phase === 'creating' ? 'Initializing' : 'Details'}</span>
        </div>

        <div className="zbd-app-create-body">
          <div className="zbd-app-create-grid">
            <div className="zbd-app-create-preview">
              {ready ? (
                <AgentAvatar
                  ref={completeRef}
                  color={color}
                  renderer="complete"
                  shape={shape}
                  size={176}
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
                  shape={shape}
                  size={176}
                  state={phase === 'creating' ? 'spawning' : 'idle'}
                  theme={theme}
                />
              )}
              <span className="zbd-app-create-hint">
                {ready ? 'Bot initialized' : phase === 'creating' ? 'Initializing computer…' : 'Drag to rotate'}
              </span>
              <div aria-hidden="true" className="zbd-app-create-hidden-complete">
                <AgentAvatar
                  ref={hiddenCompleteRef}
                  color={color}
                  renderer="complete"
                  shape={shape}
                  size={512}
                  state="finished"
                  theme={theme}
                />
              </div>
            </div>

            <div className="zbd-app-create-fields">
              <label className="zbd-app-create-field">
                <span>Name</span>
                <input
                  autoFocus
                  disabled={phase !== 'editing' || locked}
                  maxLength={64}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Chief, Scout, Operator"
                  value={name}
                />
              </label>

              <div className="zbd-app-create-field">
                <span>Model</span>
                {models.length ? (
                  <WorkModelSelector
                    className="zbd-app-create-model"
                    disabled={phase !== 'editing' || locked}
                    initialView="models"
                    models={modelOptions(models)}
                    onValueChange={(next) => setModelId(next.modelId)}
                    value={{ modelId }}
                  />
                ) : (
                  <a className="zbd-app-create-provider-link" href="/settings/ai-providers">
                    Configure an AI provider <ArrowRight size={14} />
                  </a>
                )}
              </div>

              <div className="zbd-app-create-field">
                <span>Color</span>
                <div className="zbd-app-create-colors">
                  {COLORS.map((option) => (
                    <button
                      aria-label={option.label}
                      aria-pressed={color === option.id}
                      className="zbd-app-create-color"
                      disabled={phase !== 'editing' || locked}
                      key={option.id}
                      onClick={() => setColor(option.id)}
                      style={{ background: option.swatch }}
                      title={option.label}
                      type="button"
                    >
                      {color === option.id ? <Check className="size-3 text-white mix-blend-difference" /> : null}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="zbd-app-create-field zbd-app-create-forms">
            <span>Form</span>
            <div className="zbd-app-create-form-grid">
              {SHAPES.map((option) => (
                <button
                  aria-label={option.label}
                  aria-pressed={shape === option.id}
                  className="zbd-app-create-form"
                  disabled={phase !== 'editing' || locked}
                  key={option.id}
                  onClick={() => setShape(option.id)}
                  title={option.label}
                  type="button"
                >
                  <AgentAvatar
                    color={color}
                    renderer="svg"
                    shape={option.id}
                    size={26}
                    state="idle"
                    theme={theme}
                  />
                </button>
              ))}
            </div>
          </div>

          {!workHostReady ? (
            <p
              className="mt-2.5 rounded-xl border border-[var(--app-warning-surface)] bg-[var(--app-warning-surface)] px-3 py-2 text-[12px] leading-5 text-[var(--app-warning)]"
              role="alert"
            >
              Work Host is not running. Start the OpenLink runtime so the Bot can be created.
            </p>
          ) : null}
          {error ? <p className="zbd-app-create-error" role="alert">{error}</p> : null}
        </div>

        <div className="zbd-app-create-footer">
          <button className="zbd-app-create-cancel" disabled={phase !== 'editing' || locked} onClick={closeDialog} type="button">
            Cancel
          </button>
          {locked && phase === 'editing' && createdBot ? (
            <button
              className="zbd-app-create-cancel"
              onClick={() => notifyCreated(createdBot)}
              type="button"
            >
              Open Bot
            </button>
          ) : null}
          <button
            className="zbd-app-create-submit"
            disabled={phase !== 'editing' || !models.length || !workHostReady}
            onClick={() => void create()}
            type="button"
          >
            {phase === 'creating' ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {phase === 'creating' ? 'Initializing' : ready ? 'Opening Bot' : locked ? 'Retry initialization' : 'Create Bot'}
            {phase === 'editing' ? <ArrowRight className="size-4" /> : null}
          </button>
        </div>
      </div>
    </div>
  )
}
