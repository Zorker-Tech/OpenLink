'use client'

import type { SupabaseAccessMode } from '@/lib/chat-sessions'
import { Hand, ShieldCheck, Unlock } from 'lucide-react'
import { useState } from 'react'

const OPTIONS: Array<{ value: SupabaseAccessMode; label: string; description: string; icon: typeof ShieldCheck }> = [
  { value: 'restricted', label: '受控', description: '仅只读操作，走防护墙', icon: ShieldCheck },
  { value: 'ask', label: '询问', description: '写操作需用户确认', icon: Hand },
  { value: 'open', label: '开放', description: '完全访问，不做限制', icon: Unlock },
]

function currentOption(value: SupabaseAccessMode) {
  return OPTIONS.find((option) => option.value === value) ?? OPTIONS[0]!
}

/**
 * Bare-icon Supabase access-mode control for the left of the composer. Renders
 * only the current mode's SVG icon; opens a selection drawer upward with the
 * full option names.
 */
export function SupabaseAccessModePicker({
  value,
  onChange,
}: {
  value: SupabaseAccessMode
  onChange: (mode: SupabaseAccessMode) => void
}) {
  const [open, setOpen] = useState(false)
  const active = currentOption(value)
  const ActiveIcon = active.icon

  return (
    <span className="relative inline-flex shrink-0">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Supabase 访问模式：${active.label}（${active.description}）`}
        className="flex size-6 items-center justify-center rounded-md text-[var(--app-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]"
        onClick={() => setOpen((current) => !current)}
        title={`${active.label}：${active.description}`}
        type="button"
      >
        <ActiveIcon className="size-3.5" />
      </button>
      {open && (
        <div
          className="absolute bottom-[calc(100%+6px)] left-0 z-30 w-[190px] rounded-lg border border-[var(--app-border)] bg-[var(--app-elevated)] p-1 shadow-[0_10px_28px_var(--app-shadow)]"
          role="menu"
        >
          {OPTIONS.map((option) => {
            const Icon = option.icon
            const selected = option.value === value
            return (
              <button
                aria-pressed={selected}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${selected ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]'}`}
                key={option.value}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
                role="menuitem"
                type="button"
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium">{option.label}</span>
                  <span className="block truncate text-[10px] text-[var(--app-subtle-foreground)]">{option.description}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </span>
  )
}
