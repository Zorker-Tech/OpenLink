'use client'

import { ShieldAlert } from 'lucide-react'

export interface ComposerConfirmationRequest {
  id: string
  title: string
  message?: string
  options?: string[]
  inputKind?: 'confirm' | 'select' | 'input' | 'editor'
}

export function ChatConfirmationDock({
  onResolve,
  requests,
}: {
  onResolve: (id: string, approved: boolean, value?: string) => void
  requests: ComposerConfirmationRequest[]
}) {
  if (requests.length === 0) return null

  return (
    <div aria-label="待确认操作" aria-live="polite" className="relative z-10 mx-[21px] flex flex-col-reverse gap-1">
      {requests.map((request) => (
        <section
          className="flex h-9 min-w-0 items-center gap-2 rounded-t-[12px] border border-b-0 border-[var(--app-border)] bg-[var(--app-elevated)] px-3.5 py-2 text-[12px] leading-[18px] text-[var(--app-foreground)]"
          key={request.id}
          role="alert"
        >
          <ShieldAlert className="size-4 shrink-0 text-[var(--app-muted)]" />
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <span className="shrink-0 font-medium">{request.title}</span>
            {request.message ? <span className="min-w-0 truncate text-[var(--app-muted)]" title={request.message}>{request.message}</span> : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              className="flex h-6 items-center justify-center rounded-md border border-[var(--app-control-border)] bg-transparent px-2.5 text-[11px] font-medium text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]"
              onClick={() => onResolve(request.id, false)}
              type="button"
            >
              跳过
            </button>
            <button
              className="flex h-6 items-center justify-center rounded-md bg-[var(--app-submit-background)] px-2.5 text-[11px] font-medium text-[var(--app-submit-foreground)] hover:opacity-90"
              onClick={() => onResolve(request.id, true)}
              type="button"
            >
              确认
            </button>
          </div>
        </section>
      ))}
    </div>
  )
}
