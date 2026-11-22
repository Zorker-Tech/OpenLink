'use client'

import { Popover } from '@base-ui/react/popover'
import { BookOpen, FileText, HelpCircle, Monitor, Moon, Settings2, Sun } from 'lucide-react'
import Link from 'next/link'
import { useOpenLinkTheme } from '@/components/ui/theme-scope'
import { useT } from '@/lib/i18n/client'
import { theme } from '@/lib/theme'

export type ThemeMode = 'system' | 'light' | 'dark'

const resources = [
  { label: '开发者', icon: BookOpen, href: 'https://github.com/Zorker-Tech/OpenLink/blob/HEAD/docs/platform-sdk-integration.md' },
  { label: '条款', icon: FileText, href: 'https://github.com/Zorker-Tech/OpenLink/blob/HEAD/LICENSE' },
  { label: '帮助', icon: HelpCircle, href: 'https://github.com/Zorker-Tech/OpenLink/blob/HEAD/docs/architecture/architectures/README.md' },
] as const

const displayModes = [
  { label: '跟随系统', value: 'system', icon: Monitor },
  { label: '浅色模式', value: 'light', icon: Sun },
  { label: '深色模式', value: 'dark', icon: Moon },
] as const

const itemClass = 'flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-sm transition-colors ' + theme('hover')

export function AccountDrawer({ anchor, mode, onClose, onModeChange, sideOffset }: {
  anchor?: Popover.Positioner.Props['anchor']
  mode: ThemeMode
  onClose: () => void
  onModeChange: (mode: ThemeMode) => void
  sideOffset: number
}) {
  const t = useT()
  const activeTheme = useOpenLinkTheme()

  return (
    <Popover.Portal>
      <Popover.Positioner align="start" anchor={anchor} className="workspace-account-drawer-positioner" side="top" sideOffset={sideOffset}>
        <Popover.Popup
          aria-label={t('账户菜单')}
          className="workspace-account-drawer rounded-xl border p-1.5 shadow-[0_12px_32px_var(--app-shadow)] outline-none"
          data-openlink-theme={activeTheme}
          render={<section />}
        >
          <div className="px-2.5 py-2">
            <div aria-label={t('主题模式')} className={`inline-flex h-8 items-center gap-0.5 rounded-lg p-0.5 ${theme('subtleSurface')}`} role="group">
              {displayModes.map(({ label, value, icon: Icon }) => (
                <button
                  aria-label={t(label)}
                  aria-pressed={mode === value}
                  className={`flex h-7 w-[30px] items-center justify-center rounded-md ${mode === value ? `${theme('surface')} shadow-sm` : theme('muted', 'hover')}`}
                  key={value}
                  onClick={() => onModeChange(value)}
                  type="button"
                >
                  <Icon aria-hidden="true" className="size-3.5" strokeWidth={1.8} />
                </button>
              ))}
            </div>
          </div>

          <nav aria-label={t('账户设置')}>
            <Link className={itemClass} href="/settings" onNavigate={onClose} scroll={false}>
              <Settings2 aria-hidden="true" size={18} strokeWidth={1.8} />
              <span>{t('设置')}</span>
            </Link>
            {resources.map(({ label, icon: Icon, href }) => (
              <a className={itemClass} href={href} key={href} onClick={onClose} rel="noreferrer" target="_blank">
                <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
                <span>{t(label)}</span>
              </a>
            ))}
          </nav>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  )
}
