'use client'

import type { BotRoutine } from '@/lib/bot-types'
import { ArrowRight, Clock, LoaderCircle, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'

type BotRoutineDialogProps = {
  botName: string
  routine?: BotRoutine | null
  onClose: () => void
  onDelete?: () => Promise<void>
  onSave: (spec: { name: string; prompt: string; schedule: string; isEnabled: boolean }) => Promise<void>
}

export function BotRoutineDialog({ botName, routine, onClose, onDelete, onSave }: BotRoutineDialogProps) {
  const [name, setName] = useState(routine?.name ?? '')
  const [prompt, setPrompt] = useState(routine?.prompt ?? '')
  const [schedule, setSchedule] = useState(routine?.schedule ?? '0 9 * * 1-5')
  const [isEnabled, setIsEnabled] = useState(routine?.isEnabled ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [onClose, saving])

  const submit = async () => {
    const cleanName = name.trim()
    const cleanPrompt = prompt.trim()
    const cleanSchedule = schedule.trim()
    if (!cleanName || !cleanPrompt || !cleanSchedule) {
      setError('Add a name, instructions, and a schedule.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave({ name: cleanName, prompt: cleanPrompt, schedule: cleanSchedule, isEnabled })
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The routine could not be saved.')
      setSaving(false)
    }
  }

  return (
    <div className="zbd-app-palette-layer">
      <button aria-label="Close routine" className="zbd-app-palette-scrim" onClick={() => { if (!saving) onClose() }} type="button" />
      <div aria-label={routine ? 'Edit routine' : 'Create a routine'} aria-modal="true" className="zbd-app-palette zbd-app-create-palette" role="dialog">
        <div className="zbd-app-palette-search">
          <span className="zbd-app-palette-to">{routine ? 'Edit routine' : 'New routine'}</span>
          <button aria-label="Close routine" className="zbd-app-create-back" disabled={saving} onClick={onClose} type="button">
            <X className="size-4" />
          </button>
        </div>

        <div className="zbd-app-create-body">
          <div className="zbd-app-create-fields">
            <label className="zbd-app-create-field">
              <span>Name</span>
              <input autoFocus disabled={saving} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Morning briefing" value={name} />
            </label>
            <label className="zbd-app-create-field">
              <span>Instructions for {botName}</span>
              <textarea
                className="min-h-[112px] w-full resize-none rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3 py-2.5 text-[13px] leading-5 text-[var(--app-foreground)] outline-none placeholder:text-[var(--app-subtle-foreground)] focus:border-[var(--app-focus-ring)]"
                disabled={saving}
                maxLength={100_000}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Check my calendar and summarize what needs attention."
                value={prompt}
              />
            </label>
            <label className="zbd-app-create-field">
              <span>Schedule</span>
              <input disabled={saving} maxLength={160} onChange={(event) => setSchedule(event.target.value)} placeholder="0 9 * * 1-5" value={schedule} />
            </label>
            <p className="text-[11px] leading-4 text-[var(--app-subtle-foreground)]">
              Use a cron expression. Example: <span className="text-[var(--app-muted)]">0 9 * * 1-5</span> runs weekdays at 9:00 AM.
            </p>
            <button
              aria-checked={isEnabled}
              className="zbd-app-setting-toggle"
              disabled={saving}
              onClick={() => setIsEnabled((value) => !value)}
              role="switch"
              type="button"
            >
              <span>
                <strong>Enabled</strong>
                <small>{routine ? 'Run this routine on its schedule' : 'Start running after creation'}</small>
              </span>
              <span className="zbd-app-switch" data-on={isEnabled ? '' : undefined}><span /></span>
            </button>
            {error ? <p className="text-[12px] leading-5 text-[var(--app-danger)]" role="alert">{error}</p> : null}
          </div>
        </div>

        <div className="zbd-app-create-footer">
          {routine && onDelete ? (
            <button
              className="zbd-app-create-cancel"
              disabled={saving}
              onClick={() => {
                setSaving(true)
                void onDelete().catch((deleteError) => {
                  setError(deleteError instanceof Error ? deleteError.message : 'The routine could not be deleted.')
                  setSaving(false)
                })
              }}
              type="button"
            >
              <Trash2 className="size-3.5" />
              Delete
            </button>
          ) : null}
          <span className="flex-1" />
          <button className="zbd-app-create-cancel" disabled={saving} onClick={onClose} type="button">Cancel</button>
          <button className="zbd-app-create-submit" disabled={saving} onClick={() => void submit()} type="button">
            {saving ? <LoaderCircle className="size-4 animate-spin" /> : <Clock className="size-4" />}
            {saving ? 'Saving' : routine ? 'Save routine' : 'Create routine'}
            {!saving ? <ArrowRight className="size-4" /> : null}
          </button>
        </div>
      </div>
    </div>
  )
}
