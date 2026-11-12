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
import { ArrowRight, Check, LoaderCircle, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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

  return (
    <div className="bot-onboarding onboarding-entrance flex min-h-dvh flex-col bg-[var(--app-background)] text-[var(--app-foreground)]">
      <header className="flex h-14 shrink-0 items-center justify-between px-5 md:px-8">
        <div className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden="true" className="grid size-7 place-items-center rounded-lg bg-[var(--app-active)]">
            <img alt="" className="size-4" src="/openlink/navigation/bot.svg" />
          </span>
          <span className="truncate text-[13px] font-medium tracking-[-0.08px]">{workspaceName}</span>
          <span className="text-[13px] text-[var(--app-subtle-foreground)]">/</span>
          <span className="text-[13px] text-[var(--app-muted)]">Bots</span>
        </div>
        {!firstBot && onCancel ? (
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
        ) : null}
      </header>

      <main className="mx-auto grid w-full max-w-[1120px] flex-1 grid-cols-1 items-center gap-8 px-5 pb-10 md:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)] md:px-10 lg:gap-16">
        <section aria-label="Bot preview" className="relative flex min-h-[340px] items-center justify-center md:min-h-[560px]">
          <div className="pointer-events-none absolute inset-x-[16%] bottom-[12%] h-24 rounded-full bg-[var(--app-brand)] opacity-[0.06] blur-3xl" />
          <div className="relative grid place-items-center">
            {ready ? (
              <AgentAvatar
                ref={completeRef}
                clickAction="bounce"
                color={color}
                followPointer
                hoverTilt
                renderer="complete"
                shape={shape}
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
                shape={shape}
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
                shape={shape}
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
                <span className="text-[11px] text-[var(--app-subtle-foreground)]">{shape}</span>
              </div>
              <div className="grid max-h-[156px] grid-cols-7 gap-1.5 overflow-y-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-surface)] p-2 [scrollbar-width:thin] sm:grid-cols-9">
                {SHAPES.map((option) => (
                  <button
                    aria-label={option.label}
                    aria-pressed={shape === option.id}
                    className={`grid aspect-square place-items-center rounded-lg transition-colors ${shape === option.id ? 'bg-[var(--app-selected)]' : 'hover:bg-[var(--app-hover)]'}`}
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
                      size={30}
                      state="idle"
                      theme={theme}
                    />
                  </button>
                ))}
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
    </div>
  )
}
