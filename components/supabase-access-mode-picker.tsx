'use client'

import type { SupabaseAccessMode } from '@/lib/chat-sessions'
import { Hand, ShieldCheck, Unlock } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

const OPTIONS: Array<{ value: SupabaseAccessMode; label: string; title: string; icon: typeof ShieldCheck }> = [
  { value: 'restricted', label: '受控', title: '受控模式：仅只读操作，走防护墙', icon: ShieldCheck },
  { value: 'ask', label: '询问', title: '询问模式：写操作需用户确认', icon: Hand },
  { value: 'open', label: '开放', title: '开放模式：完全访问，不做限制', icon: Unlock },
]

/** Rough width (px) needed to render the icon + label comfortably. */
const LABEL_REQUIRED_WIDTH = 128

function currentOption(value: SupabaseAccessMode) {
  return OPTIONS.find((option) => option.value === value) ?? OPTIONS[0]!
}

/**
 * Compact, space-adaptive Supabase access-mode control for the left side of the
 * composer. Shows icon + label when the container has room; collapses to the
 * icon alone when it does not. Opens a menu with the full names when clicked.
 */
export function SupabaseAccessModePicker({
  value,
  onChange,
  className,
}: {
  value: SupabaseAccessMode
  onChange: (mode: SupabaseAccessMode) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [hasSpace, setHasSpace] = useState(true)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const active = currentOption(value)
  const ActiveIcon = active.icon
  // The label is shown when there is room, or when hovering/opening the menu.
  const showLabel = hasSpace || hovered || open

  useEffect(() => {
    const element = buttonRef.current
    const parent = element?.parentElement
    if (!element || !parent) return
    const measure = () => setHasSpace(parent.getBoundingClientRect().width >= LABEL_REQUIRED_WIDTH)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [])

  return (
    <div className={`relative ${className ?? ''}`}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Supabase 访问模式：${active.title}`}
        className="flex h-6 items-center gap-1 rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-1.5 text-[11px] font-medium text-[var(--app-muted)] transition-colors hover:text-[var(--app-foreground)]"
        onClick={() => setOpen((current) => !current)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        ref={buttonRef}
        type="button"
      >
        <ActiveIcon className="size-3 shrink-0" />
        {showLabel && <span className="truncate">{active.label}</span>}
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+4px)] z-30 w-[180px] rounded-lg border border-[var(--app-border)] bg-[var(--app-elevated)] p-1 shadow-[0_10px_28px_var(--app-shadow)]">
          {OPTIONS.map((option) => {
            const Icon = option.icon
            const selected = option.value === value
            return (
              <button
                aria-pressed={selected}
                className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] ${selected ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]'}`}
                key={option.value}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
                type="button"
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
