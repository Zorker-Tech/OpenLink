'use client'

import { saveUserPreferencesAction } from '@/app/settings/actions'
import { AppSelect } from '@/components/ui/app-select'
import { useT } from '@/lib/i18n/client'
import { LOCALES, LOCALE_LABELS } from '@/lib/i18n/locales'
import type { UserPreferences } from '@/lib/user-preference-types'
import { Check, Loader2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

export function PreferencesForm({ initial }: { initial: UserPreferences }) {
  const [value, setValue] = useState(initial)
  const [status, setStatus] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()
  const t = useT()
  const savedMessage = t('已保存')

  const save = () => startTransition(async () => {
    const result = await saveUserPreferencesAction(value)
    if (!result.ok) { setStatus(result.error); return }
    window.localStorage.setItem('openlink-theme', value.theme)
    setStatus(savedMessage)
    window.dispatchEvent(new StorageEvent('storage', { key: 'openlink-theme', newValue: value.theme }))
    // Server-rendered copy (html lang, server components, metadata) re-renders
    // in the newly selected language immediately after a language change.
    router.refresh()
  })

  return (
    <div className="mx-auto w-full max-w-[738px] pb-16 pt-12 lg:pt-0">
      <div>
        <h1 className="text-2xl font-medium leading-8 tracking-[-0.89px]">{t('Interface and Theme')}</h1>
        <p className="mt-2 text-sm leading-5 text-[var(--app-muted)]">{t('管理 OpenLink 的界面、语言与 Agent 默认偏好。')}</p>
      </div>
      <div className="mt-10 border-t border-[var(--app-border)]">
        <SettingRow description={t('Choose how OpenLink looks on this device.')} label={t('Theme')}>
          <AppSelect ariaLabel={t('Theme')} className="w-36" onValueChange={(theme) => setValue((current) => ({ ...current, theme: theme as UserPreferences['theme'] }))} options={[{ label: t('System'), value: 'system' }, { label: t('Light'), value: 'light' }, { label: t('Dark'), value: 'dark' }]} value={value.theme} />
        </SettingRow>
        <SettingRow description={t('Choose the language used throughout OpenLink.')} label={t('Language')}>
          <AppSelect ariaLabel={t('Language')} className="w-52" onValueChange={(locale) => setValue((current) => ({ ...current, locale: locale as UserPreferences['locale'] }))} options={LOCALES.map((locale) => ({ label: LOCALE_LABELS[locale], value: locale }))} value={value.locale} />
        </SettingRow>
        <SettingRow description={t('Choose whether the chat renders thinking details or keeps the summary only.')} label={t('Thinking Accessibility')}>
          <AppSelect ariaLabel={t('Thinking Visibility')} className="w-36" onValueChange={(thinkingVisibility) => setValue((current) => ({ ...current, thinkingVisibility: thinkingVisibility as UserPreferences['thinkingVisibility'] }))} options={[{ label: t('Details'), value: 'summary' }, { label: t('Summary only'), value: 'hidden' }]} value={value.thinkingVisibility} />
        </SettingRow>
        <SettingRow description={t('Choose which side of the screen the chat is on.')} label={t('Chat Position')}>
          <AppSelect ariaLabel={t('Chat Position')} className="w-36" onValueChange={(chatPosition) => setValue((current) => ({ ...current, chatPosition: chatPosition as UserPreferences['chatPosition'] }))} options={[{ label: t('Left'), value: 'left' }, { label: t('Right'), value: 'right' }]} value={value.chatPosition} />
        </SettingRow>
      </div>
      <div className="mt-4">
        <label className="text-sm font-medium">{t('Custom Instructions')}</label>
        <p className="mt-0.5 text-sm text-[var(--app-muted)]">{t('Manage your custom user rules or preferences for the LLM.')}</p>
        <textarea className="mt-4 min-h-[120px] w-full resize-y rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)] p-3 text-sm leading-5 outline-none focus:border-[var(--app-focus-ring)]" maxLength={12000} onChange={(event) => setValue((current) => ({ ...current, customInstructions: event.target.value }))} placeholder={t('例如：默认使用中文回答，修改代码前先说明影响范围。')} value={value.customInstructions} />
      </div>
      <div className="mt-4 flex items-center justify-end gap-3">
        {status && <span className={`text-sm ${status === savedMessage ? 'text-[var(--app-success)]' : 'text-[var(--app-danger)]'}`}>{status === savedMessage && <Check className="mr-1 inline size-4" />}{status}</span>}
        <button className="flex h-9 items-center gap-2 rounded-md bg-[var(--app-submit-background)] px-4 text-sm font-medium text-[var(--app-submit-foreground)] disabled:opacity-50" disabled={pending} onClick={save} type="button">{pending && <Loader2 className="size-4 animate-spin" />}{t('Save')}</button>
      </div>
    </div>
  )
}

export function SettingRow({ children, description, label }: { children: React.ReactNode; description: string; label: string }) {
  return (
    <div className="flex min-h-[74px] items-center gap-4 border-b border-[var(--app-border)] py-4">
      <div className="min-w-0 flex-1"><div className="text-sm font-medium">{label}</div><div className="mt-0.5 break-words text-sm text-[var(--app-muted)]">{description}</div></div>
      {children}
    </div>
  )
}
