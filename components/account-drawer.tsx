'use client'

import {
  BookOpen,
  Bot,
  Building2,
  ChevronRight,
  FileText,
  HelpCircle,
  LogOut,
  Moon,
  Monitor,
  Sun,
  UserCircle,
} from 'lucide-react'
import { createClient } from '@/utils/supabase/client'
import type { ActiveWorkspaceSummary } from '@/components/workspace-switcher'
import type { OrganizationSummary } from '@/lib/organizations'
import { useT } from '@/lib/i18n/client'
import type { Translator } from '@/lib/i18n/messages'
import { theme } from '@/lib/theme'
import { useOpenLinkTheme } from '@/components/ui/theme-scope'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'

interface AccountDrawerProps {
  avatarUrl: string | null
  email: string
  mode: ThemeMode
  nickname: string
  activeWorkspace: ActiveWorkspaceSummary
  organizations: OrganizationSummary[]
  onOpenOrganization: () => void
  onModeChange: (mode: ThemeMode) => void
}

function themeOptions(t: Translator) {
  return [
    { label: t('跟随系统'), mode: 'system' as const, icon: Monitor },
    { label: t('浅色模式'), mode: 'light' as const, icon: Sun },
    { label: t('深色模式'), mode: 'dark' as const, icon: Moon },
  ]
}

function menuItems(t: Translator) {
  return [
    { label: t('组织设置'), icon: Building2, divider: false, href: null },
    { label: t('个人设置'), icon: UserCircle, divider: false, href: '/settings' },
    { label: t('AI 服务商'), icon: Bot, divider: false, href: '/settings/ai-providers' },
    { label: t('开发者文档'), icon: BookOpen, divider: true, href: null },
    { label: t('条款与政策'), icon: FileText, divider: false, href: null },
    { label: t('帮助'), icon: HelpCircle, divider: false, href: null },
  ] as const
}

function AccountAvatar({ avatarUrl, nickname }: { avatarUrl: string | null; nickname: string }) {
  return (
    <span className={`flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-semibold ${theme('subtleSurface')}`}>
      {avatarUrl ? <img alt="" className="size-full object-cover" src={avatarUrl} /> : nickname.trim().charAt(0).toUpperCase() || 'O'}
    </span>
  )
}

export function AccountDrawer({
  activeWorkspace,
  avatarUrl,
  email,
  mode,
  nickname,
  onModeChange,
  onOpenOrganization,
  organizations,
}: AccountDrawerProps) {
  const t = useT()
  const router = useRouter()
  const activeTheme = useOpenLinkTheme()
  const supabase = useMemo(() => createClient(), [])
  const [isSigningOut, setIsSigningOut] = useState(false)
  const featuredOrganization = organizations.find((organization) => organization.id === activeWorkspace.organizationId) ?? organizations[0]

  const handleSignOut = async () => {
    setIsSigningOut(true)
    await supabase.auth.signOut({ scope: 'local' })
    router.replace('/')
    router.refresh()
  }

  return (
    <section
      aria-label={t('账户菜单')}
      className={`absolute bottom-[52px] left-2 z-50 w-[250px] overflow-hidden rounded-xl border p-1 shadow-[0_12px_32px_var(--app-shadow)] ${theme('elevated', 'softBorder')}`}
      data-openlink-theme={activeTheme}
    >
      <div className="px-2.5 pt-2 pb-1.5">
        <p className={`truncate text-sm leading-[22px] tracking-[-0.16px] ${theme('muted')}`}>{email}</p>
        <div className="pt-1.5">
          <div aria-label={t('主题模式')} className={`flex h-8 w-[98px] items-center gap-0.5 rounded-lg p-0.5 ${theme('subtleSurface')}`}>
            {themeOptions(t).map(({ label, mode: optionMode, icon: Icon }) => (
              <button
                aria-label={label}
                aria-pressed={mode === optionMode}
                className={`flex h-7 w-[30px] shrink-0 items-center justify-center rounded-md transition-colors ${mode === optionMode ? `${theme('surface')} shadow-sm` : `${theme('muted', 'hover')} hover:text-[var(--app-foreground)]`}`}
                key={optionMode}
                onClick={() => onModeChange(optionMode)}
                type="button"
              >
                <Icon className="size-3.5" strokeWidth={1.8} />
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={`my-1 h-px ${theme('divider')}`} />

      <button
        className={`flex min-h-[58px] w-full items-center gap-2 rounded-lg px-1.5 pt-2.5 pb-1.5 text-left transition-colors ${theme('hover')}`}
        onClick={() => featuredOrganization ? router.push(`/app/${featuredOrganization.workspaceSlug}`) : onOpenOrganization()}
        type="button"
      >
        {featuredOrganization ? <AccountAvatar avatarUrl={null} nickname={featuredOrganization.name} /> : <span className={`flex size-6 shrink-0 items-center justify-center rounded-full ${theme('subtleSurface')}`}><Building2 className="size-3.5" /></span>}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm leading-[22px]">{featuredOrganization?.name ?? t('添加组织')}</span>
          <span className={`block text-xs leading-[18px] ${theme('muted')}`}>
            {featuredOrganization ? ({ owner: t('所有者'), admin: t('管理员'), member: t('成员') } as const)[featuredOrganization.role] : t('创建或加入组织')}
          </span>
        </span>
        <ChevronRight className={`size-4 shrink-0 ${theme('muted')}`} strokeWidth={1.8} />
      </button>

      <div className={`my-1 h-px ${theme('divider')}`} />

      <nav aria-label={t('账户设置')} className="py-1">
        {menuItems(t).map(({ label, icon: Icon, divider, href }) => (
          <div key={label}>
            {divider && <div className={`my-1 h-px ${theme('divider')}`} />}
            <button className={`flex h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors ${theme('hover')}`} onClick={() => { if (href) router.push(href) }} type="button">
              <Icon className="size-5 shrink-0" strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          </div>
        ))}
      </nav>

      <div className={`my-1 h-px ${theme('divider')}`} />
      <button className={`flex h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors disabled:opacity-50 ${theme('hover')}`} disabled={isSigningOut} onClick={handleSignOut} type="button">
        <LogOut className="size-5 shrink-0" strokeWidth={1.8} />
        <span>{isSigningOut ? t('退出中…') : t('退出登录')}</span>
      </button>
    </section>
  )
}
