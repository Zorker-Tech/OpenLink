'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { SettingRow } from '@/components/settings/preferences-form'
import { CloudBrowserError, createCloudConnectionsBrowser, type CloudConnectionSummary } from '@/lib/platform-cloud-browser'

const zh = {
  title: 'Cloud 账号', description: '管理 Hydite 授权。账号授权不代表项目或运行环境已经就绪。',
  loading: '正在读取连接…', unknown: '连接状态暂时不可用', empty: '尚未连接 Hydite 账号', connect: '连接账号', refresh: '刷新状态',
  disabled: 'Cloud 登录尚未开放；现有授权状态仍可查看。', stored: '授权已保存，尚未验证',
  verified: '身份已验证', required: '需要重新授权', pending: '远端撤销待确认',
  disconnect: '解除授权', retry: '重试撤销', removed: '授权已撤销', pendingNotice: '此连接已停用，远端撤销仍待确认。可重试；不会删除云项目或文件。',
  error: '暂时无法完成操作，请刷新状态后重试。', expired: 'OpenLink 登录已过期，请重新登录。',
  conflict: '连接状态已变化，请刷新后操作。', limited: '请求过于频繁，请稍后重试。',
}
const en: typeof zh = {
  title: 'Cloud account', description: 'Manage Hydite authorization. Authorization alone does not mean a project or runtime is ready.',
  loading: 'Loading connections…', unknown: 'Connection status is unavailable', empty: 'No Hydite account connected', connect: 'Connect account', refresh: 'Refresh status',
  disabled: 'Cloud sign-in is not enabled. Existing authorization status is still available.', stored: 'Authorization stored; not verified',
  verified: 'Identity verified', required: 'Reauthorization required', pending: 'Remote revocation pending',
  disconnect: 'Disconnect', retry: 'Retry revocation', removed: 'Authorization revoked', pendingNotice: 'This connection is inactive; remote revocation is pending. You can retry. Cloud projects and files are not deleted.',
  error: 'The operation could not be completed. Refresh status before retrying.', expired: 'Your OpenLink session expired. Sign in again.',
  conflict: 'Connection state changed. Refresh before continuing.', limited: 'Too many requests. Try again later.',
}

export function CloudConnectionsSettings({ loginEnabled, locale }: { loginEnabled: boolean; locale: 'zh-CN' | 'en-US' }) {
  const copy = locale === 'en-US' ? en : zh
  const api = useMemo(() => createCloudConnectionsBrowser(), [])
  const [rows, setRows] = useState<CloudConnectionSummary[]>([])
  const [verified, setVerified] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const busy = useRef(false), mounted = useRef(false), current = useRef<AbortController | null>(null)
  const errorMessage = useCallback((error: unknown) => error instanceof CloudBrowserError && error.code === 'AUTHENTICATION_REQUIRED' ? copy.expired
    : error instanceof CloudBrowserError && error.code === 'CONNECTION_CONFLICT' ? copy.conflict
      : error instanceof CloudBrowserError && error.code === 'RATE_LIMITED' ? copy.limited : copy.error, [copy])

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
            setMessage(result === 'pending' ? copy.pendingNotice : copy.removed)
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
      <h2 id="cloud-account-heading" className="text-lg font-medium tracking-tight">{copy.title}</h2>
      <p className="mt-2 text-sm leading-5 text-[var(--app-muted)]">{copy.description}</p>
      <div className="mt-6 border-t border-[var(--app-border)]">
        {loading ? <p className="flex items-center gap-2 py-5 text-sm text-[var(--app-muted)]"><Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />{copy.loading}</p>
          : !loaded ? <p className="py-5 text-sm text-[var(--app-muted)]">{copy.unknown}</p>
            : rows.length === 0 ? <p className="py-5 text-sm text-[var(--app-muted)]">{copy.empty}</p>
            : rows.map(row => <SettingRow key={row.id} label={row.state === 'revoking' ? copy.pending : row.state === 'reauth_required' ? copy.required : verified[row.id] ? copy.verified : copy.stored} description={row.subject}>
              <button type="button" className={button} disabled={pending} onClick={() => void act('disconnect', row)}>{row.state === 'revoking' ? copy.retry : copy.disconnect}</button>
            </SettingRow>)}
      </div>
      {!loginEnabled && <p className="mt-3 text-sm text-[var(--app-muted)]">{copy.disabled}</p>}
      <p role="status" aria-live="polite" className="mt-3 min-h-5 text-sm text-[var(--app-muted)]">{message}</p>
      <div className="mt-4 flex flex-wrap justify-end gap-3">
        <button type="button" className={button} disabled={loading || pending} onClick={() => void act('refresh')}>{copy.refresh}</button>
        <button type="button" className={'flex h-9 items-center gap-2 rounded-md bg-[var(--app-submit-background)] px-4 text-sm font-medium text-[var(--app-submit-foreground)] disabled:opacity-50 ' + focus} disabled={!loginEnabled || !loaded || loading || pending || hasCurrent} onClick={() => void act('connect')}>
          {pending && <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}{copy.connect}
        </button>
      </div>
    </section>
  )
}
