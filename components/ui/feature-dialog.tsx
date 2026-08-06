'use client'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { ComponentProps } from 'react'

export type FeatureDialogProps = ComponentProps<typeof Dialog>

export function FeatureDialog(props: FeatureDialogProps) {
  return <Dialog {...props} />
}

export const FeatureDialogTrigger = DialogTrigger

export function FeatureDialogContent({
  className,
  theme,
  ...props
}: ComponentProps<typeof DialogContent> & { theme?: 'light' | 'dark' }) {
  return (
    <DialogContent
      className={cn(
        'w-[min(440px,calc(100vw-32px))] max-w-none gap-0 overflow-hidden rounded-2xl border border-border bg-popover p-0 text-popover-foreground shadow-[0_24px_64px_var(--app-shadow)] ring-0',
        '[&_[data-slot=dialog-close]]:top-3 [&_[data-slot=dialog-close]]:right-3 [&_[data-slot=dialog-close]]:text-current',
        className,
      )}
      data-openlink-theme={theme}
      {...props}
    />
  )
}

export function FeatureDialogHeader({ className, ...props }: ComponentProps<typeof DialogHeader>) {
  return <DialogHeader className={cn('gap-1.5 border-b border-border px-5 py-4 pr-12', className)} {...props} />
}

export function FeatureDialogTitle({ className, ...props }: ComponentProps<typeof DialogTitle>) {
  return <DialogTitle className={cn('text-base leading-6 font-semibold tracking-[-0.2px]', className)} {...props} />
}

export function FeatureDialogDescription({ className, ...props }: ComponentProps<typeof DialogDescription>) {
  return <DialogDescription className={cn('text-sm leading-5 text-muted-foreground', className)} {...props} />
}

export function FeatureDialogBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-5 py-5', className)} {...props} />
}

export function FeatureDialogFooter({ className, ...props }: ComponentProps<typeof DialogFooter>) {
  return (
    <DialogFooter
      className={cn('m-0 rounded-none border-t border-border bg-muted/40 px-5 py-3', className)}
      {...props}
    />
  )
}
