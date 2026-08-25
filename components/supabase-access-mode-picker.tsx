'use client'

import type { SupabaseAccessMode } from '@/lib/chat-sessions'
import { Hand, ShieldCheck, Unlock } from 'lucide-react'

const OPTIONS: Array<{ value: SupabaseAccessMode; label: string; title: string; icon: typeof ShieldCheck }> = [
  { value: 'restricted', label: '受控', title: '受控模式：仅只读操作，走防护墙', icon: ShieldCheck },
  { value: 'ask', label: '询问', title: '询问模式：写操作需用户确认', icon: Hand },
  { value: 'open', label: '开放', title: '开放模式：完全访问，不做限制', icon: Unlock },
]

export function SupabaseAccessModePicker({
  value,
  onChange,
  className,
}: {
  value: SupabaseAccessMode
  onChange: (mode: SupabaseAccessMode) => void
  className?: string
}) {
  return (
    <div aria-label="Supabase 访问模式" className={`flex items-center gap-px rounded-full bg-[var(--app-subtle-surface)] p-px text-[12px] ${className ?? ''}`}>
      {OPTIONS.map((option) => {
        const Icon = option.icon
        const active = option.value === value
        return (
          <button
            aria-pressed={active}
            className={`flex h-6 items-center gap-1 rounded-full px-2 text-[12px] font-medium transition-colors ${active ? 'bg-[var(--app-surface)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:text-[var(--app-foreground)]'}`}
            key={option.value}
            onClick={() => onChange(option.value)}
            title={option.title}
            type="button"
          >
            <Icon className="size-3" />
            <span>{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}
