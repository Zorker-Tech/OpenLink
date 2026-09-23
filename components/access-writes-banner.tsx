'use client'

import { approveAccessWriteAction, listPendingAccessWritesAction, type PendingAccessWrite } from '@/app/chat/actions'
import { useT } from '@/lib/i18n/client'
import { Check, Loader2, ShieldQuestion, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

export function AccessWritesBanner({ sessionId }: { sessionId: string }) {
  const [items, setItems] = useState<PendingAccessWrite[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [approving, setApproving] = useState<string | null>(null)
  const t = useT()

  const refresh = useCallback(async () => {
    setLoading(true)
    const result = await listPendingAccessWritesAction(sessionId)
    setItems(result.confirmations)
    setError(result.error)
    setLoading(false)
  }, [sessionId])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 8_000)
    return () => clearInterval(timer)
  }, [refresh])

  if (items.length === 0 && !error) return null

  return (
    <div className="mx-4 mb-2 rounded-xl border border-[var(--app-warning)] bg-[color-mix(in_oklab,var(--app-warning)_12%,transparent)] p-3 text-[var(--app-foreground)]">
      <div className="flex items-center gap-2">
        <ShieldQuestion className="size-4 text-[var(--app-warning)]" />
        <span className="text-sm font-medium">{t('Supabase 写操作待确认')}</span>
        {loading && <Loader2 className="size-3.5 animate-spin text-[var(--app-muted)]" />}
      </div>
      <ul className="mt-2 space-y-2">
        {items.map((item) => (
          <li className="flex items-start gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)] p-2" key={item.id}>
            <code className="min-w-0 flex-1 break-all font-mono text-[11px] leading-4 text-[var(--app-foreground)]">{item.sql}</code>
            <button
              aria-label={t('批准此写操作')}
              className="flex h-6 shrink-0 items-center gap-1 rounded-md bg-[var(--app-success)] px-2 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
              disabled={approving === item.id}
              onClick={async () => {
                setApproving(item.id)
                await approveAccessWriteAction(sessionId, item.id)
                setApproving(null)
                await refresh()
              }}
              type="button"
            >
              <Check className="size-3" />{t('批准')}
            </button>
            <button
              aria-label={t('忽略此写操作')}
              className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-[var(--app-control-border)] px-2 text-[11px] font-medium text-[var(--app-muted)] hover:text-[var(--app-foreground)]"
              onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))}
              type="button"
            >
              <X className="size-3" />{t('忽略')}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-[11px] text-[var(--app-danger)]">{error}</p>}
    </div>
  )
}
