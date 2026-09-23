'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { SettingRow } from '@/components/settings/preferences-form'
import { useT } from '@/lib/i18n/client'
import type { Locale } from '@/lib/i18n/locales'
import { CloudBrowserError, createCloudConnectionsBrowser, type CloudConnectionSummary } from '@/lib/platform-cloud-browser'

export function CloudConnectionsSettings({ loginEnabled }: { loginEnabled: boolean; locale: Locale }) {
  const t = useT()
  const api = useMemo(() => createCloudConnectionsBrowser(), [])
  const [rows, setRows] = useState<CloudConnectionSummary[]>([])
  const [verified, setVerified] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const busy = useRef(false), mounted = useRef(false), current = useRef<AbortController | null>(null)
  const errorMessage = useCallback((error: unknown) => error instanceof CloudBrowserError && error.code === 'AUTHENTICATION_REQUIRED' ? t('OpenLink 登录已过期，请重新登录。')
    : error instanceof CloudBrowserError && error.code === 'CONNECTION_CONFLICT' ? t('连接状态已变化，请刷新后操作。')
      : error instanceof CloudBrowserError && error.code === 'RATE_LIMITED' ? t('请求过于频繁，请稍后重试。') : t('暂时无法完成操作，请刷新状态后重试。'), [t])

  const load = useCallback(async (signal: AbortSignal) => {
    if (mounted.current) { setLoading(true); setLoaded(false); setVerified({}) }
    const next = (await api.list(signal)).filter(row => row.state !== 'revoked')
    if (!mounted.current || signal.aborted) return
    setRows(next); setLoaded(true); setLoading(false)
    // At most one active connection is allowed by the database; still bound reads.
    for (const row of next.filter(row => row.state === 'active' || row.state === 'refreshing').slice(0, 8)) {
      try {
        const result = await api.verify(row, signal)
        if (mounted.current && !signal.aborted) {
          setVerified(value => ({ ...value, [row.id]: result.connected }))
          if (!result.connected) setRows(value => value.map(item => item.id === row.id ? { ...item, state: result.state } : item).filter(item => item.state !== 'revoked'))
        }
      } catch (error) {
        if (mounted.current && !signal.aborted) setMessage(errorMessage(error))
      }
    }
  }, [api, errorMessage])

  useEffect(() => {
    mounted.current = true
    busy.current = false; setPending(false)
    const controller = new AbortController(); current.current = controller
    setLoading(true)
    load(controller.signal).catch(error => { if (!controller.signal.aborted) setMessage(errorMessage(error)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { mounted.current = false; controller.abort(); current.current?.abort() }
  }, [load, errorMessage])

  const act = async (action: 'refresh' | 'connect' | 'disconnect', row?: CloudConnectionSummary) => {
    if (busy.current) return
    busy.current = true; setPending(true); setMessage(null)
    current.current?.abort()
    const controller = new AbortController(); current.current = controller
    try {
      if (action === 'connect') {
        const url = await api.start(controller.signal)
        if (mounted.current && !controller.signal.aborted && current.current === controller) window.location.assign(url)
      }
      else {
        if (action === 'disconnect' && row) {
          const result = await api.disconnect(row.id, controller.signal)
          if (mounted.current && !controller.signal.aborted) {
            setMessage(result === 'pending' ? t('此连接已停用，远端撤销仍待确认。可重试；不会删除云项目或文件。') : t('授权已撤销'))
            setVerified(value => ({ ...value, [row.id]: false }))
            setRows(value => result === 'revoked' ? value.filter(item => item.id !== row.id) : value.map(item => item.id === row.id ? { ...item, state: 'revoking' } : item))
          }
        }
        await load(controller.signal)
      }
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setMessage(errorMessage(error))
    } finally {
      if (current.current === controller) {
        busy.current = false
        if (mounted.current && !controller.signal.aborted) { setPending(false); setLoading(false) }
      }
    }
  }
  const hasCurrent = rows.some(row => ['active', 'refreshing', 'reauth_required'].includes(row.state))
  const focus = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-focus-ring)]'
  const button = 'h-9 shrink-0 rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3 text-sm font-medium disabled:opacity-50 ' + focus
  return (
    <section aria-labelledby="cloud-account-heading" aria-busy={loading || pending} className="mx-auto w-full max-w-[738px] pb-16">
      <h2 id="cloud-account-heading" className="text-lg font-medium tracking-tight">{t('Cloud 账号')}</h2>
      <p className="mt-2 text-sm leading-5 text-[var(--app-muted)]">{t('管理 Hydite 授权。账号授权不代表项目或运行环境已经就绪。')}</p>
      <div className="mt-6 border-t border-[var(--app-border)]">
        {loading ? <p className="flex items-center gap-2 py-5 text-sm text-[var(--app-muted)]"><Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />{t('正在读取连接…')}</p>
          : !loaded ? <p className="py-5 text-sm text-[var(--app-muted)]">{t('连接状态暂时不可用')}</p>
            : rows.length === 0 ? <p className="py-5 text-sm text-[var(--app-muted)]">{t('尚未连接 Hydite 账号')}</p>
            : rows.map(row => <SettingRow key={row.id} label={row.state === 'revoking' ? t('远端撤销待确认') : row.state === 'reauth_required' ? t('需要重新授权') : verified[row.id] ? t('身份已验证') : t('授权已保存，尚未验证')} description={row.subject}>
              <button type="button" className={button} disabled={pending} onClick={() => void act('disconnect', row)}>{row.state === 'revoking' ? t('重试撤销') : t('解除授权')}</button>
            </SettingRow>)}
      </div>
      {!loginEnabled && <p className="mt-3 text-sm text-[var(--app-muted)]">{t('Cloud 登录尚未开放；现有授权状态仍可查看。')}</p>}
      <p role="status" aria-live="polite" className="mt-3 min-h-5 text-sm text-[var(--app-muted)]">{message}</p>
      <div className="mt-4 flex flex-wrap justify-end gap-3">
        <button type="button" className={button} disabled={loading || pending} onClick={() => void act('refresh')}>{t('刷新状态')}</button>
        <button type="button" className={'flex h-9 items-center gap-2 rounded-md bg-[var(--app-submit-background)] px-4 text-sm font-medium text-[var(--app-submit-foreground)] disabled:opacity-50 ' + focus} disabled={!loginEnabled || !loaded || loading || pending || hasCurrent} onClick={() => void act('connect')}>
          {pending && <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}{t('连接账号')}
        </button>
      </div>
    </section>
  )
}
