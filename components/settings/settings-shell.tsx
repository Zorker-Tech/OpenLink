'use client'

import { OpenLinkThemeProvider } from '@/components/ui/theme-scope'
import { AppSidebarFrame } from '@/components/app-sidebar-frame'
import { AppSidebarAccountFooter, AppSidebarWorkspaceHeader } from '@/components/app-sidebar-controls'
import { OrganizationDialog } from '@/components/organization-dialog'
import type { ActiveWorkspaceSummary, PersonalWorkspaceSummary } from '@/components/workspace-switcher'
import { useT } from '@/lib/i18n/client'
import type { Translator } from '@/lib/i18n/messages'
import type { OrganizationSummary } from '@/lib/organizations'
import type { UserPreferences } from '@/lib/user-preference-types'
import {
  Activity,
  ArrowLeft,
  Blocks,
  BookOpen,
  Bot,
  CreditCard,
  KeyRound,
  Settings2,
  SlidersHorizontal,
  Users,
  Zap,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'

interface SettingsShellProps {
  activeWorkspace: ActiveWorkspaceSummary
  avatarUrl: string | null
  children: React.ReactNode
  email: string
  nickname: string
  organizations: OrganizationSummary[]
  personalWorkspace: PersonalWorkspaceSummary
  preferences: UserPreferences
}

function settingsSections(t: Translator) {
  return [
    { title: t('账户'), items: [{ href: '/settings', label: t('偏好设置'), icon: SlidersHorizontal }] },
    {
      title: t('AI'),
      items: [
        { href: '/settings/ai-providers', label: t('AI 服务商'), icon: Bot },
      ],
    },
    {
      title: t('工作区'),
      items: [
        { href: null, label: t('通用'), icon: Settings2 },
        { href: null, label: t('Memories'), icon: BookOpen },
        { href: '/settings/skills', label: t('Skills'), icon: Zap },
        { href: null, label: t('集成'), icon: Blocks },
        { href: null, label: t('账单'), icon: CreditCard },
        { href: null, label: t('成员'), icon: Users },
        { href: null, label: t('用量与活动'), icon: Activity },
        { href: null, label: t('API 密钥'), icon: KeyRound },
      ],
    },
  ] as const
}

export function SettingsShell({ activeWorkspace, avatarUrl, children, email, nickname, organizations, personalWorkspace, preferences }: SettingsShellProps) {
  const t = useT()
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [organizationDialogOpen, setOrganizationDialogOpen] = useState(false)
  const [systemLight, setSystemLight] = useState(false)
  const [themeMode, setThemeMode] = useState(preferences.theme)

  useEffect(() => {
    const saved = window.localStorage.getItem('openlink-theme')
    if (saved === 'light' || saved === 'dark' || saved === 'system') setThemeMode(saved)
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const update = () => setSystemLight(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key === 'openlink-theme' && (event.newValue === 'light' || event.newValue === 'dark' || event.newValue === 'system')) setThemeMode(event.newValue)
    }
    window.addEventListener('storage', update)
    return () => window.removeEventListener('storage', update)
  }, [])

  const theme = themeMode === 'light' || (themeMode === 'system' && systemLight) ? 'light' : 'dark'

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
  }, [theme])

  const sections = useMemo(() => settingsSections(t), [t])

  const navigation = useMemo(() => (
    <>
      <div className="flex flex-col gap-3 py-2">
        <AppSidebarWorkspaceHeader activeWorkspace={activeWorkspace} onAddOrganization={() => setOrganizationDialogOpen(true)} onToggle={() => { if (window.innerWidth >= 768) setCollapsed(true); else setMobileOpen(false) }} organizations={organizations} personalWorkspace={personalWorkspace} />
        <div className="px-2">
          <Link className="relative flex h-8 items-center justify-center rounded-md px-2 text-sm font-medium text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]" href={`/app/${activeWorkspace.slug}`}>
            <ArrowLeft className="absolute left-2 size-4" strokeWidth={1.8} />
            <span>{t('返回')}</span>
          </Link>
        </div>
      </div>
      <nav aria-label={t('设置导航')} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-6">
        <div className="space-y-4">
          {sections.map((section) => (
            <section key={section.title}>
              <h2 className="flex h-[30px] items-center px-2 text-[13px] font-medium text-[var(--app-muted)]">{section.title}</h2>
              <div className="space-y-0.5">
                {section.items.map(({ href, label, icon: Icon }) => {
                  if (!href) return (
                    <span aria-disabled="true" className="flex h-8 cursor-not-allowed items-center gap-2 rounded-md px-2 text-sm text-[var(--app-subtle)] opacity-55" key={label} title={t('即将开放')}>
                      <Icon className="size-4 shrink-0" strokeWidth={1.8} />
                      <span>{label}</span>
                    </span>
                  )
                  const active = href === '/settings' ? pathname === href : pathname.startsWith(href)
                  return (
                    <Link aria-current={active ? 'page' : undefined} className={`flex h-8 items-center gap-2 rounded-md px-2 text-sm ${active ? 'bg-[var(--app-selected)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]'}`} href={href} key={href} onClick={() => setMobileOpen(false)}>
                      <Icon className="size-4 shrink-0" strokeWidth={1.8} />
                      <span>{label}</span>
                    </Link>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </nav>
      <AppSidebarAccountFooter activeWorkspace={activeWorkspace} avatarUrl={avatarUrl} email={email} nickname={nickname} onOpenOrganization={() => setOrganizationDialogOpen(true)} onThemeChange={(mode) => { setThemeMode(mode); window.localStorage.setItem('openlink-theme', mode) }} organizations={organizations} themeMode={themeMode} />
    </>
  ), [activeWorkspace, avatarUrl, email, nickname, organizations, pathname, personalWorkspace, t, themeMode])

  const providerSettings = pathname.startsWith('/settings/ai-providers')
  const skillSettings = pathname.startsWith('/settings/skills')

  return (
    <OpenLinkThemeProvider theme={theme}>
      <div className="openlink-app-shell flex h-dvh min-h-[520px] overflow-hidden bg-[var(--app-background)]" data-theme={theme}>
        <AppSidebarFrame collapsed={collapsed} mobileOpen={mobileOpen} onCloseMobile={() => setMobileOpen(false)}>{navigation}</AppSidebarFrame>
        <main className="relative min-w-0 flex-1 overflow-hidden">
          <button aria-label={t('打开设置导航')} className={`absolute left-3 top-[10px] z-30 flex size-8 items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-surface)] text-[var(--app-muted)] shadow-sm transition-[left,opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${collapsed ? `${skillSettings ? 'md:left-[294px]' : providerSettings ? 'md:left-[286px]' : 'md:left-3'} md:translate-x-0 md:opacity-100` : 'md:pointer-events-none md:translate-x-[-8px] md:opacity-0'}`} onClick={() => { if (window.innerWidth >= 768) setCollapsed(false); else setMobileOpen(true) }} type="button"><img alt="" className="app-control-icon size-4 rotate-180" src="/openlink/app/sidebar-toggle.svg" /></button>
          {children}
        </main>
        <OrganizationDialog onOpenChange={setOrganizationDialogOpen} open={organizationDialogOpen} />
      </div>
    </OpenLinkThemeProvider>
  )
}
