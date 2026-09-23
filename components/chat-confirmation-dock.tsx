'use client'

import { ShieldAlert } from 'lucide-react'
import { useState } from 'react'

import { useT } from '@/lib/i18n/client'

export interface ComposerConfirmationRequest {
  id: string
  title: string
  message?: string
  options?: string[]
  inputKind?: 'confirm' | 'select' | 'input' | 'editor'
  confirmationKind?: 'approval' | 'question'
}

export function ChatConfirmationDock({
  onResolve,
  requests,
}: {
  onResolve: (id: string, approved: boolean, value?: string) => Promise<void> | void
  requests: ComposerConfirmationRequest[]
}) {
  const [resolving, setResolving] = useState<Set<string>>(() => new Set())
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const t = useT()
  if (requests.length === 0) return null

  const resolve = async (request: ComposerConfirmationRequest, approved: boolean, value?: string) => {
    if (resolving.has(request.id)) return
    setResolving((current) => new Set(current).add(request.id))
    setErrors((current) => {
      const next = { ...current }
      delete next[request.id]
      return next
    })
    try {
      await onResolve(request.id, approved, value)
    } catch (error) {
      setErrors((current) => ({ ...current, [request.id]: error instanceof Error ? error.message : t('操作失败，请重试') }))
    } finally {
      setResolving((current) => {
        const next = new Set(current)
        next.delete(request.id)
        return next
      })
    }
  }

  return (
    <div aria-label={t('待确认操作')} aria-live="polite" className="relative z-10 mx-[21px] flex flex-col gap-1">
      {requests.map((request) => (
        <section
          aria-busy={resolving.has(request.id)}
          aria-label={request.confirmationKind === 'approval' ? t('审批：{title}', { title: request.title }) : t('问题：{title}', { title: request.title })}
          className={`relative flex min-w-0 items-center gap-2 border border-b-0 border-[var(--app-border)] bg-[var(--app-elevated)] px-3.5 py-2 text-[12px] leading-[18px] text-[var(--app-foreground)] first:rounded-t-[12px] ${request.inputKind && request.inputKind !== 'confirm' ? 'min-h-9 flex-wrap' : 'h-9'}`}
          key={request.id}
          role={request.confirmationKind === 'approval' ? 'alert' : 'group'}
        >
          <ShieldAlert className="size-4 shrink-0 text-[var(--app-muted)]" />
          <div className={`flex min-w-0 flex-1 gap-1 ${request.inputKind && request.inputKind !== 'confirm' ? 'basis-[85%] flex-col' : 'items-center'}`}>
            <span className="shrink-0 font-medium">{request.title}</span>
            {request.message ? <span className={`min-w-0 text-[var(--app-muted)] ${request.inputKind && request.inputKind !== 'confirm' ? 'whitespace-pre-wrap break-words' : 'truncate'}`} title={request.message}>{request.message}</span> : null}
          </div>
          {request.inputKind === 'select' && request.options?.length ? (
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {request.options.map((option) => (
                <button
                  className="flex h-6 max-w-[180px] items-center justify-center truncate rounded-md border border-[var(--app-control-border)] bg-transparent px-2 text-[11px] font-medium text-[var(--app-foreground)] hover:bg-[var(--app-hover)] disabled:pointer-events-none disabled:opacity-50"
                  disabled={resolving.has(request.id)}
                  key={option}
                  onClick={() => { void resolve(request, true, option) }}
                  title={option}
                  type="button"
                >
                  {option}
                </button>
              ))}
            </div>
          ) : null}
          {request.inputKind === 'input' ? (
            <input
              aria-label={request.title}
              className="h-6 min-w-[120px] max-w-[220px] rounded-md border border-[var(--app-control-border)] bg-transparent px-2 text-[11px] text-[var(--app-foreground)] outline-none focus:border-[var(--app-focus-ring)]"
              disabled={resolving.has(request.id)}
              onChange={(event) => {
                const value = event.currentTarget.value
                setDrafts((current) => ({ ...current, [request.id]: value }))
              }}
              placeholder={t('输入内容')}
              value={drafts[request.id] ?? ''}
            />
          ) : null}
          {request.inputKind === 'editor' ? (
            <textarea
              aria-label={request.title}
              className="max-h-20 min-h-6 min-w-[160px] max-w-[260px] resize-y rounded-md border border-[var(--app-control-border)] bg-transparent px-2 py-1 text-[11px] leading-4 text-[var(--app-foreground)] outline-none focus:border-[var(--app-focus-ring)]"
              disabled={resolving.has(request.id)}
              onChange={(event) => {
                const value = event.currentTarget.value
                setDrafts((current) => ({ ...current, [request.id]: value }))
              }}
              placeholder={t('输入内容')}
              value={drafts[request.id] ?? ''}
            />
          ) : null}
          <div className="flex shrink-0 items-center gap-1">
            <button
              className="flex h-6 items-center justify-center rounded-md border border-[var(--app-control-border)] bg-transparent px-2.5 text-[11px] font-medium text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]"
              disabled={resolving.has(request.id)}
              onClick={() => { void resolve(request, false) }}
              type="button"
            >
              {request.confirmationKind === 'approval' ? t('拒绝') : t('跳过')}
            </button>
            {request.inputKind !== 'select' ? <button
              className="flex h-6 items-center justify-center rounded-md bg-[var(--app-submit-background)] px-2.5 text-[11px] font-medium text-[var(--app-submit-foreground)] hover:opacity-90"
              disabled={resolving.has(request.id)}
              onClick={() => { void resolve(request, true, request.inputKind === 'input' || request.inputKind === 'editor' ? drafts[request.id] ?? '' : undefined) }}
              type="button"
            >
              {resolving.has(request.id) ? t('处理中') : request.confirmationKind === 'approval' ? t('允许') : t('提交')}
            </button> : null}
          </div>
          {errors[request.id] ? <span className="basis-full pl-6 text-[10px] text-[var(--app-danger)]" role="alert">{errors[request.id]}</span> : null}
        </section>
      ))}
    </div>
  )
}
