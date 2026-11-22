'use client'

import { Bot, Settings2, X, Zap } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { OpenLinkThemeProvider } from '@/components/ui/theme-scope'
import { useT } from '@/lib/i18n/client'
import type { UserPreferences } from '@/lib/user-preference-types'

const settingsSections = [
  { href: '/settings', label: '通用', icon: Settings2 },
  { href: '/settings/ai-providers', label: 'AI 服务商', icon: Bot },
  { href: '/settings/skills', label: 'Skills', icon: Zap },
] as const

export function SettingsShell({ children, closeHref, intercepted = false, initialTheme }: {
  children: ReactNode
  closeHref: string
  intercepted?: boolean
  initialTheme: UserPreferences['theme']
}) {
  const t = useT()
  const pathname = usePathname()
  const router = useRouter()
  const [themeMode, setThemeMode] = useState(initialTheme)
  const [systemLight, setSystemLight] = useState(false)

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const updateSystem = () => setSystemLight(media.matches)
    const updateMode = () => {
      try {
        const saved = window.localStorage.getItem('openlink-theme')
        setThemeMode(saved === 'light' || saved === 'dark' || saved === 'system' ? saved : initialTheme)
      } catch {
        setThemeMode(initialTheme)
      }
    }
    updateMode()
    updateSystem()
    window.addEventListener('storage', updateMode)
    media.addEventListener('change', updateSystem)
    return () => {
      window.removeEventListener('storage', updateMode)
      media.removeEventListener('change', updateSystem)
    }
  }, [initialTheme])

  const theme = themeMode === 'light' || (themeMode === 'system' && systemLight) ? 'light' : 'dark'
  const onProviders = pathname.startsWith('/settings/ai-providers')
  const onEmbeddings = pathname.startsWith('/settings/ai-providers/embeddings')
  return (
    <OpenLinkThemeProvider theme={theme}>
      <Dialog open onOpenChange={(open) => {
        if (open) return
        if (intercepted) router.back()
        else router.replace(closeHref)
      }}>
        <DialogContent
          className="settings-dialog"
          data-openlink-theme={theme}
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">{t('设置')}</DialogTitle>
          <nav aria-label={t('设置分区')} className="settings-dialog-navigation">
            <span className="settings-dialog-caption">{t('设置')}</span>
            {settingsSections.map(({ href, icon: Icon, label }) => {
              const current = pathname === href || (href !== '/settings' && pathname.startsWith(href + '/'))
              return (
                <Link aria-current={current ? 'page' : undefined} className="settings-dialog-link" href={href} key={href} replace scroll={false}>
                  <Icon aria-hidden="true" size={17} strokeWidth={1.75} />
                  <span>{t(label)}</span>
                </Link>
              )
            })}
          </nav>
          <div className="settings-dialog-content">
            {onProviders && (
              <nav aria-label={t('AI 服务商')} className="settings-dialog-provider-tabs">
                <Link aria-current={!onEmbeddings ? 'page' : undefined} className="settings-dialog-link" href="/settings/ai-providers" replace scroll={false}>{t('普通')}</Link>
                <Link aria-current={onEmbeddings ? 'page' : undefined} className="settings-dialog-link" href="/settings/ai-providers/embeddings" replace scroll={false}>{t('向量')}</Link>
              </nav>
            )}
            <div className="settings-dialog-body" key={pathname}>{children}</div>
          </div>
          <DialogClose aria-label={t('关闭设置')} className="settings-dialog-close">
            <X aria-hidden="true" size={18} />
          </DialogClose>
        </DialogContent>
      </Dialog>
    </OpenLinkThemeProvider>
  )
}
