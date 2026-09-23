'use client'

import { PromptInputTextarea, type PromptInputTextareaProps } from '@/components/ai-elements/prompt-input'
import { useT } from '@/lib/i18n/client'
import type { PromptTrigger } from '@/lib/prompt-input-protocol'
import { promptTriggerAt, replacePromptTrigger } from '@/lib/prompt-input-protocol'
import { enabledSuggestionIndex, nextEnabledSuggestionIndex } from '@/lib/prompt-suggestion-navigation'
import { cn } from '@/lib/utils'
import { File, PackagePlus, Sparkles, TerminalSquare } from 'lucide-react'
import { createPortal } from 'react-dom'
import { forwardRef, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'

export interface AgentPromptSuggestion {
  id: string
  label: string
  description?: string
  secondaryContent?: string
  insertText: string
  kind: 'command' | 'mention' | 'skill'
  group?: string
  command?: string
  drilldown?: boolean
  replaceCommand?: boolean
  /** Actions execute locally; submenus alone retain an argument picker. */
  action?: string
  disabled?: boolean
  requiresEmptyComposer?: boolean
  resourceType?: 'file' | 'thread'
  path?: string
}

interface AgentPromptTextareaProps extends Omit<PromptInputTextareaProps, 'value'> {
  value: string
  suggestions: AgentPromptSuggestion[]
  onValueChange: (value: string) => void
  commandPaletteLabel?: string
  commandPaletteLoading?: boolean
  commandPaletteEmptyLabel?: string
  onTriggerChange?: (trigger: PromptTrigger | null) => void
  onContentSizeChange?: (scrollHeight: number) => void
  wrapperClassName?: string
  onAction?: (action: string) => void
  lineStartCommandsOnly?: boolean
  onSuggestionSelect?: (item: AgentPromptSuggestion) => boolean
}

export const AgentPromptTextarea = forwardRef<HTMLTextAreaElement, AgentPromptTextareaProps>(function AgentPromptTextarea({ value, suggestions, onValueChange, onChange, onKeyDown, onSelect, onClick, className, commandPaletteLabel, commandPaletteLoading = false, commandPaletteEmptyLabel, onTriggerChange, onContentSizeChange, wrapperClassName, onAction, onSuggestionSelect, lineStartCommandsOnly = false, ...props }, forwardedRef) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const pickerId = useId()
  const t = useT()
  const paletteLabel = commandPaletteLabel ?? t('Agent 原生指令')
  const paletteEmptyLabel = commandPaletteEmptyLabel ?? t('没有匹配项')
  useImperativeHandle(forwardedRef, () => ref.current as HTMLTextAreaElement)
  const dismissedAt = useRef<{ value: string; cursor: number } | null>(null)
  const contentSizeCallbackRef = useRef(onContentSizeChange)
  const [trigger, setTrigger] = useState<PromptTrigger | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [pickerHost, setPickerHost] = useState<HTMLElement | null>(null)
  const visible = useMemo(() => {
    if (!trigger) return []
    const query = trigger.query.toLocaleLowerCase()
    return suggestions
      .filter((item) => item.kind === trigger.kind)
      .filter((item) => !item.requiresEmptyComposer || !(value.slice(0, trigger.start) + value.slice(trigger.end)).trim())
      .filter((item) => trigger.kind !== 'command' || item.command === trigger.command)
      .filter((item) => !query || `${item.label} ${item.description ?? ''}`.toLocaleLowerCase().includes(query))
      .slice(0, 80)
  }, [suggestions, trigger, value])
  const activeSuggestionIndex = enabledSuggestionIndex(visible, activeIndex)
  const activeSuggestion = activeSuggestionIndex >= 0 ? visible[activeSuggestionIndex] : undefined

  useLayoutEffect(() => {
    setPickerHost(ref.current?.closest<HTMLElement>('[data-slot="input-group"]') ?? null)
  }, [])

  contentSizeCallbackRef.current = onContentSizeChange
  useLayoutEffect(() => {
    if (!ref.current) return
    // Controlled value updates do not emit input/change events. Report the
    // intrinsic content height after every programmatic insertion so the
    // composer can switch out of its one-line layout immediately.
    contentSizeCallbackRef.current?.(ref.current.scrollHeight)
  }, [value])

  useLayoutEffect(() => {
    const textarea = ref.current
    if (!textarea) return
    let previousWidth = textarea.getBoundingClientRect().width
    const observer = new ResizeObserver(() => {
      const width = textarea.getBoundingClientRect().width
      if (width === previousWidth) return
      previousWidth = width
      contentSizeCallbackRef.current?.(textarea.scrollHeight)
    })
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [])

  const refreshTrigger = (element: HTMLTextAreaElement, nextValue = element.value) => {
    const cursor = element.selectionStart ?? nextValue.length
    const next = dismissedAt.current?.value === nextValue && dismissedAt.current.cursor === cursor ? null
      : promptTriggerAt(nextValue, cursor, { lineStartOnly: lineStartCommandsOnly })
    setTrigger(next)
    onTriggerChange?.(next)
    setActiveIndex(0)
  }
  const choose = (item: AgentPromptSuggestion) => {
    if (!trigger || item.disabled) return
    const effectiveTrigger = item.replaceCommand && trigger.command
      ? { ...trigger, start: value.lastIndexOf('/', trigger.start) }
      : trigger
    const selectedAsReference = onSuggestionSelect?.(item) === true
    const replacement = replacePromptTrigger(value, effectiveTrigger, item.action || selectedAsReference ? '' : item.insertText)
    onValueChange(replacement.value)
    const nextTrigger = item.drilldown ? promptTriggerAt(replacement.value, replacement.cursor, { lineStartOnly: lineStartCommandsOnly }) : null
    dismissedAt.current = nextTrigger ? null : { value: replacement.value, cursor: replacement.cursor }
    setTrigger(nextTrigger)
    onTriggerChange?.(nextTrigger)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(replacement.cursor, replacement.cursor)
      if (item.action) onAction?.(item.action)
    })
  }

  const pickerLabel = trigger?.kind === 'command' ? paletteLabel : trigger?.kind === 'skill' ? 'Codex skills' : 'Codex references'
  const picker = trigger && pickerHost ? createPortal(<div className="absolute bottom-[calc(100%+8px)] left-[-1px] z-[100] max-h-[min(52vh,420px)] w-[calc(100%+2px)] overflow-hidden rounded-[20px] border border-[var(--app-border)] bg-[var(--app-elevated)] p-2 text-[var(--app-foreground)] shadow-[0_4px_80px_8px_var(--app-shadow)]">
    <div className="flex h-9 items-center gap-2 rounded-xl bg-[var(--app-active)] px-3 text-xs text-[var(--app-muted)]">
      {trigger.kind === 'command' ? <TerminalSquare className="size-4" /> : trigger.kind === 'skill' ? <Sparkles className="size-4" /> : <File className="size-4" />}
      <span className="truncate">{trigger.kind === 'command' ? trigger.command ? `/${trigger.command}` : paletteLabel : trigger.kind === 'skill' ? 'Skills' : t('引用')}</span>
      <span className="ml-auto truncate font-mono text-[11px]">{trigger.kind === 'command' ? `/${trigger.command ? `${trigger.command} ` : ''}` : trigger.kind === 'skill' ? '$' : '@'}{trigger.query}</span>
    </div>
    <div aria-busy={commandPaletteLoading} aria-label={pickerLabel} className="mt-1 max-h-[min(42vh,330px)] overflow-y-auto overscroll-contain" id={pickerId} role="listbox">
      {visible.length === 0 && <div aria-disabled="true" aria-selected="false" className="flex h-14 items-center justify-center px-3 text-xs text-[var(--app-muted)]" role="option">{commandPaletteLoading ? t('正在加载…') : paletteEmptyLabel}</div>}
      {visible.map((item, index) => <button aria-selected={index === activeSuggestionIndex} aria-disabled={item.disabled} disabled={item.disabled} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-sm hover:bg-[var(--app-hover)] aria-selected:bg-[var(--app-hover)] disabled:opacity-40" id={`${pickerId}-option-${index}`} key={item.id} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(item)} role="option" type="button">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-[var(--app-surface)] text-[var(--app-muted)] shadow-[0_4px_16px_rgba(0,0,0,0.05)]">{item.kind === 'command' ? <TerminalSquare className="size-4" /> : item.kind === 'skill' ? <Sparkles className="size-4" /> : item.group === 'Plugins' || item.group === 'Plugin Prompts' ? <PackagePlus className="size-4" /> : <File className="size-4" />}</span>
        <span className="min-w-0 flex-1"><span className="flex items-baseline gap-2"><span className="shrink-0 font-medium">{item.label}</span>{item.description && <span className="truncate text-xs text-[var(--app-muted)]">{item.description}</span>}</span></span>
        {(item.secondaryContent || item.group) && <span className="shrink-0 text-[10px] text-[var(--app-muted)]">{item.secondaryContent || item.group}</span>}
      </button>)}
    </div>
    <div className="flex h-8 items-center border-t border-[var(--app-border)] px-2 text-[11px] text-[var(--app-muted)]"><span>{t("↑↓ 选择")}</span><span className="ml-3">{t("Enter 确认")}</span><span className="ml-auto">{t("Esc 关闭")}</span></div>
  </div>, pickerHost) : null

  return <div
    aria-controls={trigger ? pickerId : undefined}
    aria-expanded={Boolean(trigger)}
    aria-haspopup="listbox"
    aria-label={typeof props['aria-label'] === 'string' ? props['aria-label'] : paletteLabel}
    className={cn('relative flex min-w-0 flex-1 items-start text-left', wrapperClassName)}
    role="combobox"
  >
    {picker}
    <PromptInputTextarea
      {...props}
      aria-activedescendant={activeSuggestion ? `${pickerId}-option-${activeSuggestionIndex}` : undefined}
      aria-autocomplete="list"
      aria-controls={trigger ? pickerId : undefined}
      aria-multiline="true"
      className={`${className ?? ''} w-full text-left`}
      onBlur={(event) => { setTrigger(null); onTriggerChange?.(null); props.onBlur?.(event) }}
      onChange={(event) => { onValueChange(event.currentTarget.value); refreshTrigger(event.currentTarget); onChange?.(event) }}
      onClick={(event) => { dismissedAt.current = null; refreshTrigger(event.currentTarget); onClick?.(event) }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (trigger && event.key === 'Escape') {
          dismissedAt.current = { value: event.currentTarget.value, cursor: event.currentTarget.selectionStart }
          event.preventDefault(); event.stopPropagation(); setTrigger(null); onTriggerChange?.(null); return
        }
        if (trigger && visible.length) {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setActiveIndex((current) => nextEnabledSuggestionIndex(visible, enabledSuggestionIndex(visible, current), event.key === 'ArrowDown' ? 1 : -1))
          } else if (event.key === 'Tab') {
            if (activeSuggestion) {
              event.preventDefault()
              choose(activeSuggestion)
            } else {
              // Do not create a keyboard trap when every visible option is
              // disabled. Let the browser move focus out of the combobox.
              setTrigger(null)
              onTriggerChange?.(null)
            }
          } else if (event.key === 'Enter' && !event.shiftKey) {
            // Keep an unavailable slash command from falling through to the
            // form submit path, while still allowing Tab to leave the field.
            event.preventDefault()
            if (activeSuggestion) choose(activeSuggestion)
          } else if (event.key === 'Escape') {
            event.preventDefault(); setTrigger(null); onTriggerChange?.(null)
          }
        }
        onKeyDown?.(event)
      }}
      onSelect={(event) => { refreshTrigger(event.currentTarget); onSelect?.(event) }}
      ref={ref}
      value={value}
    />
  </div>
})
