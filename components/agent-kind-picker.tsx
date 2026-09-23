'use client'

import type { AgentKind } from '@/lib/chat-session-types'
import { useT } from '@/lib/i18n/client'
import type { Translator } from '@/lib/i18n/messages'
import { Bot, Check, Sparkles } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useState } from 'react'

type AgentKindOption = { value: AgentKind; label: string; description: string }

function agentKindOptions(t: Translator): ReadonlyArray<AgentKindOption> {
  return [
    { value: 'codex', label: 'Codex', description: t('OpenAI Codex · 默认 Agent，自带沙箱') },
    { value: 'pi', label: 'Pi', description: t('Pi coding agent · 浏览器与 Supabase 扩展') },
  ]
}

export function AgentKindPicker({ value, onChange }: { value: AgentKind; onChange: (agent: AgentKind) => void }) {
  const [open, setOpen] = useState(false)
  const t = useT()
  const options = agentKindOptions(t)
  const active = options.find((option) => option.value === value) ?? options[0]!

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            aria-label={t('Agent：{label}（{description}）', { label: active.label, description: active.description })}
            className="flex h-[22px] items-center rounded-md px-1 text-[12px] font-medium text-[var(--app-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]"
            title={t('{label}：{description}', { label: active.label, description: active.description })}
            type="button"
          />
        }
      >
        <span>{active.label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[240px] rounded-lg border border-[var(--app-border)] bg-[var(--app-elevated)] p-1 text-[var(--app-foreground)] shadow-[0_10px_28px_var(--app-shadow)]"
        side="bottom"
      >
        {options.map((option) => {
          const selected = option.value === value
          const Icon = option.value === 'codex' ? Sparkles : Bot
          return (
            <DropdownMenuItem
              className={`h-9 cursor-pointer gap-2.5 rounded-md px-2.5 text-sm ${selected ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] focus:bg-[var(--app-hover)]'}`}
              key={option.value}
              onClick={() => onChange(option.value)}
            >
              <Icon className="size-4 text-[var(--app-muted)]" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] leading-4">{option.label}</span>
                <span className="block truncate text-[11px] text-[var(--app-subtle)]">{option.description}</span>
              </span>
              {selected && <Check className="size-4 shrink-0 text-[var(--app-foreground)]" />}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
