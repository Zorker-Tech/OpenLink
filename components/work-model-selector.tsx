"use client"

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, Zap } from 'lucide-react'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { useT } from '@/lib/i18n/client'
import { cn } from '@/lib/utils'
import styles from './work-model-selector.module.css'
import { WorkModelSelectorMotion } from './work-model-selector-motion'

export type WorkModelEffort = { id: string; label: string }
export type WorkModelOption = {
  id: string
  label: string
  description?: string
  efforts?: readonly WorkModelEffort[]
  defaultEffort?: string
  supportsFastMode?: boolean
  disabled?: boolean
}
export type WorkModelSelection = { modelId: string; effort?: string; fast?: boolean }
export type WorkModelSelectorProps = {
  models: readonly WorkModelOption[]
  value: WorkModelSelection
  onValueChange: (value: WorkModelSelection) => void
  disabled?: boolean
  className?: string
  /** Start on the model list or the selected model's controls. */
  initialView?: 'models' | 'effort'
  defaultOpen?: boolean
  labels?: Partial<{ selectModel: string; effort: string; enableFast: string; disableFast: string; empty: string }>
}

/** Presentation only: no provider, storage, network or application state dependencies. */
export function WorkModelSelector({ models, value, onValueChange, disabled, className, initialView = 'effort', defaultOpen = false, labels }: WorkModelSelectorProps) {
  const t = useT()
  const text = { selectModel: t('选择模型'), effort: t('推理强度'), enableFast: t('启用快速模式'), disableFast: t('停用快速模式'), empty: t('暂无可用模型'), ...labels }
  const selected = models.find(model => model.id === value.modelId)
  const efforts = selected?.efforts ?? []
  const effortIndex = Math.max(0, efforts.findIndex(effort => effort.id === (value.effort ?? selected?.defaultEffort)))
  const effort = efforts[effortIndex]
  const [open, setOpen] = useState(defaultOpen)
  const [view, setView] = useState(initialView)
  const [focusIndex, setFocusIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLButtonElement>(null)
  const headingId = useId()
  const listVisible = view === 'models' || !selected || !efforts.length
  const available = models.filter(model => !model.disabled)
  const selectedAvailableIndex = Math.max(0, available.findIndex(model => model.id === value.modelId))

  useEffect(() => {
    if (!open) return
    if (listVisible) {
      setFocusIndex(selectedAvailableIndex)
      listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')[selectedAvailableIndex]?.focus()
    } else headingRef.current?.focus()
  }, [open, listVisible, selectedAvailableIndex])

  function pick(model: WorkModelOption) {
    const nextEffort = model.efforts?.find(item => item.id === value.effort)?.id
      ?? model.efforts?.find(item => item.id === model.defaultEffort)?.id
      ?? model.efforts?.[0]?.id
    onValueChange({ modelId: model.id, effort: nextEffort, fast: model.supportsFastMode ? Boolean(value.fast) : false })
    if (model.efforts?.length) setView('effort')
    else setOpen(false)
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (!available.length) return
    const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0
    if (!delta && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : (focusIndex + delta + available.length) % available.length
    setFocusIndex(index)
    listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')[index]?.focus()
  }

  return <Popover open={open} onOpenChange={next => {
    setOpen(next)
    if (next) setView(initialView)
  }}>
    <PopoverTrigger disabled={disabled} className={cn(styles.trigger, className)} aria-label={t('{model}，当前 {current}{effort}', { model: text.selectModel, current: selected?.label ?? text.selectModel, effort: effort ? ` ${effort.label}` : '' })}>
      {value.fast && selected?.supportsFastMode ? <Zap aria-hidden size={14} /> : null}
      <span>{selected?.label ?? text.selectModel}</span>
      {effort ? <span className={styles.muted}>{effort.label}</span> : null}
      <ChevronDown aria-hidden size={16} className={styles.triggerChevron} />
    </PopoverTrigger>
    <PopoverContent side="top" align="end" sideOffset={8} className={styles.panel} aria-labelledby={headingId}>
      <PopoverTitle id={headingId} className="sr-only">{listVisible ? text.selectModel : `${selected?.label} ${text.effort}`}</PopoverTitle>
      <WorkModelSelectorMotion view={listVisible ? 'models' : 'effort'}>
      {listVisible ? <>
        <div className={styles.listHeading}>{text.selectModel}</div>
        <div ref={listRef} role="group" aria-label={text.selectModel} onKeyDown={navigate} className={styles.list}>
          {models.map(model => <button key={model.id} type="button" disabled={model.disabled} aria-pressed={model.id === value.modelId} className={styles.option}
            onFocus={() => setFocusIndex(available.findIndex(item => item.id === model.id))} onClick={() => pick(model)}>
            <span className={styles.optionCopy}><span>{model.label}</span>{model.description ? <span className={styles.description}>{model.description}</span> : null}</span>
            {model.id === value.modelId ? <Check aria-hidden size={16} /> : null}
          </button>)}
          {!models.length ? <p className={styles.empty}>{text.empty}</p> : null}
        </div>
      </> : <>
        <div className={styles.controlHeader}>
          {selected?.supportsFastMode ? <button type="button" className={styles.fast} aria-label={value.fast ? text.disableFast : text.enableFast} title={value.fast ? text.disableFast : text.enableFast} aria-pressed={Boolean(value.fast)} onClick={() => onValueChange({ ...value, fast: !value.fast })}><Zap aria-hidden size={16} /></button> : null}
          <button ref={headingRef} type="button" className={styles.modelHeading} aria-label={text.selectModel} onClick={() => setView('models')}>
            <span>{selected?.label}</span><span className={styles.muted}>{effort?.label}</span><ChevronDown aria-hidden size={16} />
          </button>
        </div>
        <div className={styles.sliderArea}>
          <div className={styles.track} aria-hidden><div className={styles.ticks}>{efforts.map(item => <i key={item.id} />)}</div></div>
          <input className={styles.slider} type="range" min={0} max={Math.max(0, efforts.length - 1)} step={1} value={effortIndex} disabled={efforts.length < 2}
            aria-label={text.effort} aria-valuetext={effort?.label} title={effort?.label}
            onKeyDown={event => {
              const delta = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0
              if (!delta && event.key !== 'Home' && event.key !== 'End') return
              event.preventDefault()
              const index = event.key === 'Home' ? 0 : event.key === 'End' ? efforts.length - 1 : Math.max(0, Math.min(efforts.length - 1, effortIndex + delta))
              onValueChange({ ...value, effort: efforts[index]?.id })
            }}
            onChange={event => onValueChange({ ...value, effort: efforts[Number(event.target.value)]?.id })} />
          <span aria-hidden className={styles.thumb} style={{ left: `calc(${efforts.length > 1 ? effortIndex / (efforts.length - 1) : 0} * (100% - 28px))` }}><span className={styles.thumbDot} /></span>
        </div>
      </>}
      </WorkModelSelectorMotion>
    </PopoverContent>
  </Popover>
}
