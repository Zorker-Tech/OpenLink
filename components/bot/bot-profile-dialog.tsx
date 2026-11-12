'use client'

import {
  AgentAvatar,
  COLORS,
  SHAPES,
  type AgentAvatarHandle,
} from '@zorker/avatar'
import { WorkModelSelector, type WorkModelOption } from '@/components/work-model-selector'
import type { ConfiguredModelOption } from '@/lib/ai-provider-types'
import type { BotSummary } from '@/lib/bot-types'
import { Check, LoaderCircle, Trash2 } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'

type BotProfileDialogProps = {
  bot: BotSummary
  bots: readonly BotSummary[]
  models: readonly ConfiguredModelOption[]
  theme: 'light' | 'dark'
  onClose: () => void
  onSaved: (bot: BotSummary) => void
  onDeleted: (botId: string) => void
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
    BOT_MODEL_REQUIRED: 'Choose an enabled model.',
    BOT_GROUP_MEMBER_REQUIRED: 'A group needs at least one member.',
    BOT_UPDATE_FAILED: 'Work Host could not update the Bot.',
    BOT_DELETE_FAILED: 'The Bot could not be deleted.',
  }
  return messages[code] ?? code
}

/**
 * Edit an existing Bot. The profile is the same identity the onboarding flow
 * created: name, description, avatar shape/colour and, for a single Bot, its
 * model. A group edits its member set instead of a model.
 */
export function BotProfileDialog({
  bot,
  bots,
  models,
  theme,
  onClose,
  onSaved,
  onDeleted,
}: BotProfileDialogProps) {
  const [name, setName] = useState(bot.name)
  const [description, setDescription] = useState(bot.description)
  const [shape, setShape] = useState(bot.avatarShape)
  const [color, setColor] = useState(bot.avatarColor)
  const isGroup = bot.kind === 'group'
  const initialModelId = bot.providerId && bot.modelId ? `${bot.providerId}/${bot.modelId}` : ''
  const [modelId, setModelId] = useState(initialModelId || models[0]?.id || '')
  const [memberIds, setMemberIds] = useState<string[]>(bot.memberIds)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const completeRef = useRef<AgentAvatarHandle>(null)
  const hiddenCompleteRef = useRef<AgentAvatarHandle>(null)
  const modelChoices = useMemo(() => {
    const choices = [...models]
    // A Bot can outlive a provider configuration edit. Keep its current model
    // selectable so changing the name or avatar does not require re-picking a
    // model that is no longer in the enabled catalog.
    if (!isGroup && bot.providerId && bot.modelId && !choices.some((model) => model.providerId === bot.providerId && model.modelId === bot.modelId)) {
      choices.unshift({
        id: initialModelId,
        providerId: bot.providerId,
        providerName: bot.providerId,
        modelId: bot.modelId,
        name: bot.modelId,
        logo: bot.providerId,
        isDefault: false,
      })
    }
    return choices
  }, [bot.modelId, bot.providerId, initialModelId, isGroup, models])
  const selectedModelOption = modelChoices.find((model) => model.id === modelId) ?? null
  const candidates = bots.filter((candidate) => candidate.kind === 'bot' && candidate.id !== bot.id)

  const save = useCallback(async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      // Keep the durable avatar bytes aligned with the selected identity, the
      // same way the onboarding flow does. The live renderer is still the
      // default surface; the bytes serve clients that read the avatar route.
      const png = await (hiddenCompleteRef.current?.getPngDataUrl(512)
        ?? completeRef.current?.getPngDataUrl(512)
        ?? Promise.resolve(''))
      const response = await fetch(`/api/bots/${encodeURIComponent(bot.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description,
          avatarShape: shape,
          avatarColor: color,
          ...(png ? { avatarPngBase64: png.replace(/^data:image\/png;base64,/, '') } : {}),
          ...(isGroup
            ? { memberIds }
            : selectedModelOption
              ? { model: { providerId: selectedModelOption.providerId, modelId: selectedModelOption.modelId } }
              : {}),
        }),
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => null) as {
        bot?: BotSummary
        error?: { message?: string }
      } | null
      if (!response.ok || !payload?.bot) {
        throw new Error(friendlyError(payload?.error?.message || 'BOT_UPDATE_FAILED'))
      }
      onSaved(payload.bot)
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The Bot could not be updated.')
    } finally {
      setSaving(false)
    }
  }, [bot.id, color, description, isGroup, memberIds, name, onClose, onSaved, saving, selectedModelOption, shape])

  const remove = useCallback(async () => {
    if (deleting) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setDeleting(true)
    setError(null)
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(bot.id)}`, {
        method: 'DELETE',
        cache: 'no-store',
      })
      if (!response.ok && response.status !== 204) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null
        throw new Error(friendlyError(payload?.error?.message || 'BOT_DELETE_FAILED'))
      }
      onDeleted(bot.id)
      onClose()
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'The Bot could not be deleted.')
    } finally {
      setDeleting(false)
    }
  }, [bot.id, confirmDelete, deleting, onClose, onDeleted])

  const toggleMember = (memberId: string) => {
    setMemberIds((current) => current.includes(memberId)
      ? current.filter((id) => id !== memberId)
      : [...current, memberId].slice(0, 6))
  }

  return (
    <div className="zbd-app-palette-layer" role="presentation">
      <button aria-label="Close profile" className="zbd-app-palette-scrim" onClick={onClose} type="button" />
      <div
        aria-label={`${bot.name} profile`}
        aria-modal="true"
        className="zbd-app-palette zbd-app-create-palette"
        role="dialog"
      >
        <div className="zbd-app-palette-search">
          <span className="zbd-app-palette-to">{isGroup ? 'Group profile' : 'Bot profile'}</span>
          <span className="zbd-app-create-step">{saving ? 'Saving' : 'Details'}</span>
        </div>

        <div className="zbd-app-create-body">
          <div className="zbd-app-create-grid">
            <div className="zbd-app-create-preview">
              <AgentAvatar
                ref={completeRef}
                color={color}
                renderer="complete"
                shape={shape}
                size={176}
                state="finished"
                theme={theme}
              />
              <span className="zbd-app-create-hint">{isGroup ? 'Group avatar' : 'Bot avatar'}</span>
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
                  maxLength={64}
                  onChange={(event) => setName(event.target.value)}
                  value={name}
                />
              </label>
              <label className="zbd-app-create-field">
                <span>Description</span>
                <input
                  maxLength={280}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="What this Bot is for"
                  value={description}
                />
              </label>
              {isGroup ? (
                <div className="zbd-app-create-field">
                  <span>Members</span>
                  <div className="flex flex-col gap-1.5">
                    {candidates.length ? candidates.map((candidate) => (
                      <label className="flex items-center gap-2 text-[12px] text-[var(--app-text)]" key={candidate.id}>
                        <input
                          checked={memberIds.includes(candidate.id)}
                          onChange={() => toggleMember(candidate.id)}
                          type="checkbox"
                        />
                        <span className="truncate">{candidate.name}</span>
                      </label>
                    )) : (
                      <span className="text-[12px] text-[var(--app-muted)]">Create a Bot before creating a group.</span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="zbd-app-create-field">
                  <span>Model</span>
                  {modelChoices.length ? (
                    <WorkModelSelector
                      className="zbd-app-create-model"
                      initialView="models"
                      models={modelOptions(modelChoices)}
                      onValueChange={(next) => setModelId(next.modelId)}
                      value={{ modelId }}
                    />
                  ) : (
                    <span className="text-[12px] text-[var(--app-muted)]">No model is configured.</span>
                  )}
                </div>
              )}
              <div className="zbd-app-create-field">
                <span>Color</span>
                <div className="zbd-app-create-colors">
                  {COLORS.map((option) => (
                    <button
                      aria-label={option.label}
                      aria-pressed={color === option.id}
                      className="zbd-app-create-color"
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

          {error ? <p className="zbd-app-create-error" role="alert">{error}</p> : null}
        </div>

        <div className="zbd-app-create-footer">
          <button
            className="zbd-app-create-cancel"
            disabled={saving || deleting}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="zbd-app-create-cancel"
            disabled={saving || deleting}
            onClick={() => void remove()}
            type="button"
          >
            {deleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-3.5" />}
            {confirmDelete ? 'Confirm delete' : 'Delete'}
          </button>
          <button
            className="zbd-app-create-submit"
            disabled={saving || deleting || !name.trim() || (isGroup ? memberIds.length === 0 : !selectedModelOption)}
            onClick={() => void save()}
            type="button"
          >
            {saving ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {saving ? 'Saving' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
