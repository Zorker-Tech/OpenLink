'use client'

import { useT } from '@/lib/i18n/client'
import { theme } from '@/lib/theme'
import { Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

type StudioSessionResponse = { iframeUrl?: unknown; error?: { code?: unknown } } | null

/**
 * Full-area upstream Supabase Studio surface for Local mode. Occupies the
 * entire data region of the chat workspace instead of living inside the
 * native project panel; all traffic flows through the scoped BFF proxy.
 */
export function ProjectSupabaseStudioFrame({ sessionId }: { sessionId: string }) {
  const t = useT()
  const [studioUrl, setStudioUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const openStudio = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/supabase/studio-session`, {
        method: 'POST',
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => null) as StudioSessionResponse
      if (!response.ok || typeof payload?.iframeUrl !== 'string' || !payload.iframeUrl.startsWith('http://localhost:')) {
        throw new Error(typeof payload?.error?.code === 'string' ? payload.error.code : 'LOCAL_STUDIO_UNAVAILABLE')
      }
      setStudioUrl(payload.iframeUrl)
    } catch (reason) {
      setStudioUrl(null)
      setError(reason instanceof Error ? reason.message : 'LOCAL_STUDIO_UNAVAILABLE')
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    void openStudio()
  }, [openStudio])

  return (
    <section aria-label="Supabase Studio" className="relative size-full min-w-0 overflow-hidden bg-white">
      {studioUrl && <iframe className="absolute inset-0 size-full border-0 bg-white" referrerPolicy="no-referrer" src={studioUrl} title="Project Supabase Studio" />}
      {!studioUrl && (
        <div className={`absolute inset-0 flex flex-col items-center justify-center gap-3 ${theme('canvas')}`}>
          {loading
            ? <><Loader2 className="size-4 animate-spin text-[var(--app-muted)]" /><p className={`text-sm ${theme("muted")}`}>{t("正在建立受控 Studio 会话…")}</p></>
            : <>
              <p className={`max-w-md text-center text-sm ${theme("muted")}`}>{error === "LOCAL_STUDIO_REQUIRES_LOCALHOST" ? t("请通过 http://localhost 打开 OpenLink 后使用 Supabase Studio。") : t("无法连接 Project VM 中的 Supabase Studio。")}</p>
              <button className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium ${theme("action")}`} onClick={() => { void openStudio() }} type="button"><RefreshCw className="size-3.5" />{t("重试")}</button>
            </>}
        </div>
      )}
    </section>
  )
}
