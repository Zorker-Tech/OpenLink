'use client'

import {
  BookOpen,
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
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'

interface AccountDrawerProps {
  avatarUrl: string | null
  email: string
  mode: ThemeMode
  nickname: string
  onModeChange: (mode: ThemeMode) => void
}

const themeOptions = [
  { label: '跟随系统', mode: 'system' as const, icon: Monitor },
  { label: '浅色模式', mode: 'light' as const, icon: Sun },
  { label: '深色模式', mode: 'dark' as const, icon: Moon },
]

const menuItems = [
  { label: '组织设置', icon: Building2 },
  { label: '个人设置', icon: UserCircle },
  { label: '开发者文档', icon: BookOpen, divider: true },
  { label: '条款与政策', icon: FileText },
  { label: '帮助', icon: HelpCircle },
] as const

function AccountAvatar({ avatarUrl, nickname }: { avatarUrl: string | null; nickname: string }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#5d5d5d] text-xs font-semibold text-white">
      {avatarUrl ? <img alt="" className="size-full object-cover" src={avatarUrl} /> : nickname.trim().charAt(0).toUpperCase() || 'O'}
    </span>
  )
}

export function AccountDrawer({ avatarUrl, email, mode, nickname, onModeChange }: AccountDrawerProps) {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [isSigningOut, setIsSigningOut] = useState(false)

  const handleSignOut = async () => {
    setIsSigningOut(true)
    await supabase.auth.signOut()
    router.replace('/')
    router.refresh()
  }

  return (
    <section aria-label="账户菜单" className="absolute bottom-[52px] left-2 z-50 w-[250px] overflow-hidden rounded-xl border border-[var(--app-drawer-border)] bg-[var(--app-drawer-background)] p-1 text-[var(--app-drawer-foreground)] shadow-[0_10px_15px_-3px_var(--app-drawer-shadow),0_4px_6px_-4px_var(--app-drawer-shadow)]">
      <div className="px-2.5 pt-2 pb-1.5">
        <p className="truncate text-sm leading-[22px] tracking-[-0.16px] text-[var(--app-drawer-muted)]">{email}</p>
        <div className="pt-1.5">
          <div aria-label="主题模式" className="flex h-8 w-[98px] items-center gap-0.5 rounded-lg bg-[var(--app-theme-track)] p-0.5">
            {themeOptions.map(({ label, mode: optionMode, icon: Icon }) => (
              <button
                aria-label={label}
                aria-pressed={mode === optionMode}
                className={`flex h-7 w-[30px] shrink-0 items-center justify-center rounded-md transition-colors ${mode === optionMode ? 'bg-[var(--app-theme-active)] shadow-[0_1px_4px_var(--app-drawer-shadow)]' : 'hover:bg-[var(--app-theme-hover)]'}`}
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

      <div className="my-1 h-px bg-[var(--app-drawer-divider)]" />

      <button className="flex min-h-[58px] w-full items-center gap-2 rounded-lg px-1.5 pt-2.5 pb-1.5 text-left transition-colors hover:bg-[var(--app-drawer-hover)]" type="button">
        <AccountAvatar avatarUrl={avatarUrl} nickname={nickname} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm leading-[22px]">Haokir Inc.</span>
          <span className="block text-xs leading-[18px] text-[var(--app-drawer-muted)]">Organization</span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-[var(--app-drawer-muted)]" strokeWidth={1.8} />
      </button>

      <div className="my-1 h-px bg-[var(--app-drawer-divider)]" />

      <nav aria-label="账户设置" className="py-1">
        {menuItems.map(({ label, icon: Icon, divider }) => (
          <div key={label}>
            {divider && <div className="my-1 h-px bg-[var(--app-drawer-divider)]" />}
            <button className="flex h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors hover:bg-[var(--app-drawer-hover)]" type="button">
              <Icon className="size-5 shrink-0" strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          </div>
        ))}
      </nav>

      <div className="my-1 h-px bg-[var(--app-drawer-divider)]" />
      <button className="flex h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors hover:bg-[var(--app-drawer-hover)] disabled:opacity-50" disabled={isSigningOut} onClick={handleSignOut} type="button">
        <LogOut className="size-5 shrink-0" strokeWidth={1.8} />
        <span>{isSigningOut ? '退出中…' : '退出登录'}</span>
      </button>
    </section>
  )
}
