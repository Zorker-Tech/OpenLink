'use client'

import type { AccessMode } from '@/lib/chat-sessions'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useT } from '@/lib/i18n/client'
import type { Translator } from '@/lib/i18n/messages'
import { Hand, ShieldCheck, Unlock } from 'lucide-react'

type AccessModeOption = { value: AccessMode; label: string; description: string; icon: typeof ShieldCheck }

function accessModeOptions(t: Translator): AccessModeOption[] {
  return [
    { value: 'restricted', label: t('受控'), description: t('仅只读操作，走防护墙'), icon: ShieldCheck },
    { value: 'ask', label: t('询问'), description: t('写操作需用户确认'), icon: Hand },
    { value: 'open', label: t('开放'), description: t('完全访问，不做限制'), icon: Unlock },
  ]
}

function currentOption(options: AccessModeOption[], value: AccessMode) {
  return options.find((option) => option.value === value) ?? options[0]!
}

/**
 * Bare-icon access-mode control for the left of the composer. Uses the shared
 * DropdownMenu (anchored + portaled to body) so the drawer is never clipped by
 * the composer's overflow, and opens upward with the full option names.
 */
export function AccessModePicker({
  value,
  onChange,
}: {
  value: AccessMode
  onChange: (mode: AccessMode) => void
}) {
  const t = useT()
  const options = accessModeOptions(t)
  const active = currentOption(options, value)
  const ActiveIcon = active.icon

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            aria-label={t('访问模式：{label}（{description}）', { label: active.label, description: active.description })}
            className="flex size-7 items-center justify-center rounded-md text-[var(--app-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]"
            title={t('{label}：{description}', { label: active.label, description: active.description })}
            type="button"
          />
        }
      >
        <ActiveIcon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[190px] rounded-lg border border-[var(--app-border)] bg-[var(--app-elevated)] p-1 text-[var(--app-foreground)] shadow-[0_10px_28px_var(--app-shadow)]"
        side="top"
      >
        {options.map((option) => {
          const Icon = option.icon
          const selected = option.value === value
          return (
            <DropdownMenuItem
              aria-pressed={selected}
              className={`h-9 cursor-pointer gap-2 rounded-md px-2 text-left ${selected ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] focus:bg-[var(--app-hover)] focus:text-[var(--app-foreground)]'}`}
              key={option.value}
              onSelect={() => onChange(option.value)}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium">{option.label}</span>
                <span className="block truncate text-[10px] text-[var(--app-subtle-foreground)]">{option.description}</span>
              </span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
