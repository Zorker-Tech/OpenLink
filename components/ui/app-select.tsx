'use client'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

export interface AppSelectOption {
  description?: string
  icon?: ReactNode
  label: ReactNode
  value: string
}

interface AppSelectProps {
  ariaLabel: string
  className?: string
  contentClassName?: string
  disabled?: boolean
  onValueChange: (value: string) => void
  options: AppSelectOption[]
  placeholder?: string
  value: string
}

/** Shared select/dropdown surface for settings, app controls, and AI Elements. */
export function AppSelect({ ariaLabel, className, contentClassName, disabled, onValueChange, options, placeholder, value }: AppSelectProps) {
  const selected = options.find((option) => option.value === value)

  return (
    <Select disabled={disabled} onValueChange={(nextValue) => onValueChange(String(nextValue))} value={value}>
      <SelectTrigger aria-label={ariaLabel} className={cn('w-full', className)}>
        <SelectValue>
          {selected ? <span className="flex min-w-0 items-center gap-2">{selected.icon}<span className="truncate">{selected.label}</span></span> : placeholder}
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start" className={cn('min-w-[var(--anchor-width)]', contentClassName)}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.icon}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{option.label}</span>
              {option.description && <span className="mt-0.5 block truncate text-[11px] text-[var(--app-subtle,var(--muted-foreground))]">{option.description}</span>}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
