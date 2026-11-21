'use client'

import type {
  BotInspirationRecord,
  BotInspirationState,
  BotSummary,
} from '@/lib/bot-types'
import { Brain, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

type BotInspirationPanelProps = {
  bot: BotSummary
  onEditProfile: () => void
}

const PRESETS = [
  { id: 'occasional', label: 'Occasional', hint: 'every 6h', mean: 6 * 60 * 60_000, cap: 2 },
  { id: 'curious', label: 'Curious', hint: 'every 3h', mean: 3 * 60 * 60_000, cap: 4 },
  { id: 'restless', label: 'Restless', hint: 'every hour', mean: 60 * 60_000, cap: 8 },
] as const

function formatWhen(ms: number | null): string {
  if (ms === null) return 'not scheduled'
  const delta = ms - Date.now()
  if (delta <= 0) return 'due now'
  if (delta < 60 * 60_000) return `in ${Math.max(1, Math.round(delta / 60_000))} min`
  if (delta < 24 * 60 * 60_000) return `in ${Math.round(delta / (60 * 60_000))} h`
  return `in ${Math.round(delta / (24 * 60 * 60_000))} d`
}

function recordLabel(record: BotInspirationRecord): string {
  if (record.candidate?.title) return record.candidate.title
  if (record.detail) return record.detail
  return record.decision
}

function outcomeLabel(record: BotInspirationRecord): string {
  if (record.outcome === 'acted') return `spoke${record.messageCount > 1 ? ` · ${record.messageCount} messages` : ''}`
  if (record.outcome === 'silent') return 'stayed silent'
  if (record.outcome === 'failed') return 'failed'
  return record.decision
}

function InspirationSwitch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      aria-checked={checked}
      aria-label={checked ? 'Disable proactive messages' : 'Enable proactive messages'}
      className="relative flex h-5 w-8 shrink-0 items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-focus-ring)]"
      onClick={onChange}
      role="switch"
      style={{ background: checked ? 'var(--app-submit-background)' : 'color-mix(in srgb, var(--app-foreground) 12%, transparent)' }}
      type="button"
    >
      <span
        aria-hidden
        className="size-4 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.22)] transition-transform"
        style={{ transform: checked ? 'translateX(12px)' : 'translateX(2px)' }}
      />
    </button>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[12px] leading-4 text-[var(--app-muted)]">
      <span className="font-medium text-[var(--app-muted)]">{label}</span>
      {children}
    </label>
  )
}

const inputClass = 'h-8 w-full rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2 text-[13px] text-[var(--app-foreground)] outline-none focus:border-[var(--app-focus-ring)]'

export function BotInspirationPanel({ bot, onEditProfile }: BotInspirationPanelProps) {
  const [state, setState] = useState<BotInspirationState | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dailyCap, setDailyCap] = useState('3')
  const [quietStart, setQuietStart] = useState('23')
  const [quietEnd, setQuietEnd] = useState('8')
  const [lenses, setLenses] = useState('')
  const [topics, setTopics] = useState('')

  const apply = useCallback((next: BotInspirationState | null) => {
    setState(next)
    if (!next) return
    setDailyCap(String(next.config.cadence.dailyCap))
    setQuietStart(String(next.config.quietHours.startHour))
    setQuietEnd(String(next.config.quietHours.endHour))
    setLenses(next.config.lenses.join(', '))
    setTopics(next.config.topics.join(', '))
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/bots/${encodeURIComponent(bot.id)}/inspiration`, { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as { inspiration?: BotInspirationState | null; error?: { message?: string } } | null
        if (!response.ok) throw new Error(payload?.error?.message || 'Proactive messages could not be loaded')
        if (!cancelled) apply(payload?.inspiration ?? null)
      })
      .catch((failure) => { if (!cancelled) setError(failure instanceof Error ? failure.message : 'Proactive messages could not be loaded') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [apply, bot.id])

  const patch = useCallback(async (next: Partial<BotInspirationState['config']>) => {
    if (!state || saving) return
    setSaving(true)
    setError(null)
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(bot.id)}/inspiration`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { ...state.config, ...next } }),
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => null) as { inspiration?: BotInspirationState | null; error?: { message?: string } } | null
      if (!response.ok) throw new Error(payload?.error?.message || 'Proactive messages could not be saved')
      apply(payload?.inspiration ?? state)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Proactive messages could not be saved')
    } finally {
      setSaving(false)
    }
  }, [apply, bot.id, saving, state])

  const saveDetails = useCallback(async () => {
    if (!state) return
    const cap = Number(dailyCap)
    const start = Number(quietStart)
    const end = Number(quietEnd)
    await patch({
      cadence: {
        ...state.config.cadence,
        dailyCap: Number.isFinite(cap) ? Math.min(24, Math.max(1, Math.round(cap))) : state.config.cadence.dailyCap,
      },
      quietHours: {
        startHour: Number.isFinite(start) ? Math.min(23, Math.max(0, Math.round(start))) : state.config.quietHours.startHour,
        endHour: Number.isFinite(end) ? Math.min(23, Math.max(0, Math.round(end))) : state.config.quietHours.endHour,
      },
      lenses: lenses.split(',').map((value) => value.trim()).filter(Boolean),
      topics: topics.split(',').map((value) => value.trim()).filter(Boolean),
    })
  }, [dailyCap, lenses, patch, quietEnd, quietStart, state, topics])

  const runNow = useCallback(async () => {
    if (running) return
    setRunning(true)
    setError(null)
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(bot.id)}/inspiration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run-now' }),
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null
      if (!response.ok) throw new Error(payload?.error?.message || 'Proactive messages could not run')
      const refresh = await fetch(`/api/bots/${encodeURIComponent(bot.id)}/inspiration`, { cache: 'no-store' })
      const refreshed = await refresh.json().catch(() => null) as { inspiration?: BotInspirationState | null } | null
      apply(refreshed?.inspiration ?? state)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Proactive messages could not run')
    } finally {
      setRunning(false)
    }
  }, [apply, bot.id, running, state])

  const feedback = useCallback(async (recordId: string, value: 'useful' | 'not-useful') => {
    setError(null)
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(bot.id)}/inspiration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'feedback', recordId, feedback: value }),
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => null) as { inspiration?: BotInspirationState | null; error?: { message?: string } } | null
      if (!response.ok) throw new Error(payload?.error?.message || 'Feedback could not be saved')
      apply(payload?.inspiration ?? state)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Feedback could not be saved')
    }
  }, [apply, bot.id, state])

  const history = useMemo(() => (state?.ledger ?? []).slice(-4).reverse(), [state?.ledger])
  const budget = bot.inspirationBudgetUsd
  const used = state?.usage.usd ?? 0
  const budgetRatio = budget && budget > 0 ? Math.min(1, used / budget) : null
  const activePreset = state
    ? PRESETS.find((preset) => Math.abs(preset.mean - state.config.cadence.meanIntervalMs) < 30 * 60_000)?.id
    : undefined

  if (bot.kind === 'group') return null

  return (
    <section aria-labelledby="bot-details-inspiration">
      <div className="mb-2 flex items-center justify-between px-0.5">
        <h2 className="flex items-center gap-1.5 text-[13px] leading-4 text-[var(--app-muted)]" id="bot-details-inspiration">
          <Sparkles className="size-3.5" />
          Proactive messages
        </h2>
        {state ? (
          <InspirationSwitch checked={state.config.enabled} onChange={() => void patch({ enabled: !state.config.enabled })} />
        ) : null}
      </div>

      <div className="rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)] p-3">
        {loading ? (
          <div className="space-y-2" aria-label="Loading proactive messages">
            <div className="h-4 w-2/3 animate-pulse rounded bg-[var(--app-active)]" />
            <div className="h-8 animate-pulse rounded-md bg-[var(--app-active)]" />
            <div className="h-8 animate-pulse rounded-md bg-[var(--app-active)]" />
          </div>
        ) : !state ? (
          <p className="text-[13px] leading-4 text-[var(--app-muted)]">Proactive messages are unavailable for this Bot.</p>
        ) : !state.config.enabled ? (
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium leading-4 text-[var(--app-foreground)]">Off</p>
              <p className="mt-1 text-[12px] leading-4 text-[var(--app-muted)]">
                When enabled, {bot.name} occasionally looks for useful work using its instructions, this conversation and its workspace.
              </p>
            </div>
            <button
              className="flex h-7 shrink-0 items-center rounded-md bg-[var(--app-submit-background)] px-2.5 text-[12px] font-medium text-[var(--app-submit-foreground)] transition-opacity hover:opacity-90 disabled:opacity-50"
              disabled={saving}
              onClick={() => void patch({ enabled: true })}
              type="button"
            >
              Turn on
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-md bg-[var(--app-active)] px-2.5 py-2">
              <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-medium leading-4 text-[var(--app-foreground)]">Listening for ideas</p>
                <p className="truncate text-[11px] leading-4 text-[var(--app-muted)]">
                  Next {formatWhen(state.nextFireAt)} · {state.usage.runs}/{state.config.cadence.dailyCap} today
                </p>
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-[12px] font-medium text-[var(--app-muted)]">Cadence</p>
              <div className="grid grid-cols-3 gap-1 rounded-md bg-[var(--app-active)] p-1">
                {PRESETS.map((preset) => (
                  <button
                    aria-pressed={activePreset === preset.id}
                    className={`flex h-9 flex-col items-center justify-center rounded-md text-[12px] font-medium leading-4 transition-colors ${
                      activePreset === preset.id
                        ? 'bg-[var(--app-surface)] text-[var(--app-foreground)] shadow-[0_1px_2px_var(--app-shadow)]'
                        : 'text-[var(--app-muted)] hover:text-[var(--app-foreground)]'
                    }`}
                    key={preset.id}
                    onClick={() => void patch({
                      cadence: {
                        ...state.config.cadence,
                        meanIntervalMs: preset.mean,
                        minIntervalMs: Math.max(15 * 60_000, Math.round(preset.mean / 4)),
                        maxIntervalMs: Math.max(preset.mean * 3, 24 * 60 * 60_000),
                        dailyCap: preset.cap,
                      },
                    })}
                    type="button"
                  >
                    {preset.label}
                    <span className="text-[9px] font-normal text-[var(--app-muted)]">{preset.hint}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Field label="Daily cap">
                <input className={inputClass} min={1} max={24} onChange={(event) => setDailyCap(event.target.value)} type="number" value={dailyCap} />
              </Field>
              <Field label="Quiet from">
                <input className={inputClass} max={23} min={0} onChange={(event) => setQuietStart(event.target.value)} type="number" value={quietStart} />
              </Field>
              <Field label="Quiet to">
                <input className={inputClass} max={23} min={0} onChange={(event) => setQuietEnd(event.target.value)} type="number" value={quietEnd} />
              </Field>
            </div>

            <Field label="Lenses">
              <input
                className={inputClass}
                onChange={(event) => setLenses(event.target.value)}
                placeholder="security, performance, ux, tests…"
                value={lenses}
              />
            </Field>
            <Field label="Focus topics">
              <input
                className={inputClass}
                onChange={(event) => setTopics(event.target.value)}
                placeholder="things this Bot should care about"
                value={topics}
              />
            </Field>

            <div className="rounded-md border border-[var(--app-border)] px-2.5 py-2">
              <div className="flex items-center justify-between gap-2 text-[12px] leading-4">
                <span className="text-[var(--app-muted)]">
                  Budget <span className="text-[var(--app-foreground)]">{budget === null ? 'Unlimited' : `$${budget.toFixed(2)}/day`}</span>
                </span>
                <span className="text-[var(--app-muted)]">${used.toFixed(2)} used today</span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--app-active)]">
                <div
                  className="h-full rounded-full bg-[var(--app-submit-background)] transition-[width]"
                  style={{ width: budgetRatio === null ? (used > 0 ? '12%' : '0%') : `${Math.max(2, budgetRatio * 100)}%` }}
                />
              </div>
              <button className="mt-1.5 text-[11px] font-medium text-[var(--app-muted)] hover:text-[var(--app-foreground)] hover:underline" onClick={onEditProfile} type="button">
                Change budget in profile
              </button>
            </div>

            <div className="flex items-center justify-end gap-1.5">
              <button
                className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--app-control-border)] px-2.5 text-[12px] font-medium text-[var(--app-foreground)] transition-colors hover:bg-[var(--app-hover)] disabled:opacity-50"
                disabled={saving}
                onClick={() => void saveDetails()}
                type="button"
              >
                Save
              </button>
              <button
                className="flex h-7 items-center gap-1.5 rounded-md bg-[var(--app-submit-background)] px-2.5 text-[12px] font-medium text-[var(--app-submit-foreground)] transition-opacity hover:opacity-90 disabled:opacity-50"
                disabled={running}
                onClick={() => void runNow()}
                type="button"
              >
                <Brain className="size-3" />
                {running ? 'Thinking…' : 'Inspire now'}
              </button>
            </div>

            {history.length ? (
              <div className="space-y-1 border-t border-[var(--app-border)] pt-2">
                <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--app-muted)]">Recent ideas</p>
                {history.map((record) => (
                  <div className="flex items-start gap-2 text-[12px] leading-4" key={record.id}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[var(--app-foreground)]">{recordLabel(record)}</span>
                      <span className="block truncate text-[var(--app-muted)]">{outcomeLabel(record)} · {record.lens}</span>
                    </span>
                    {record.outcome === 'acted' ? (
                      <span className="flex shrink-0 items-center gap-0.5">
                        <button
                          aria-label="Mark inspiration useful"
                          className={`rounded p-1 hover:bg-[var(--app-hover)] ${record.feedback === 'useful' ? 'text-[var(--app-foreground)]' : 'text-[var(--app-muted)]'}`}
                          onClick={() => void feedback(record.id, 'useful')}
                          type="button"
                        >
                          <ThumbsUp className="size-3" />
                        </button>
                        <button
                          aria-label="Mark inspiration not useful"
                          className={`rounded p-1 hover:bg-[var(--app-hover)] ${record.feedback === 'not-useful' ? 'text-[var(--app-foreground)]' : 'text-[var(--app-muted)]'}`}
                          onClick={() => void feedback(record.id, 'not-useful')}
                          type="button"
                        >
                          <ThumbsDown className="size-3" />
                        </button>
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}
        {error ? <p className="mt-2 text-[12px] leading-4 text-[var(--app-danger)]" role="alert">{error}</p> : null}
      </div>
    </section>
  )
}
