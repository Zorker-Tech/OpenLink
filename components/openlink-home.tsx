'use client'

import { ExternalLink } from 'lucide-react'
import type { ComposerContext } from '@/lib/composer-context'
import { PromptComposer } from '@/components/prompt-composer'
import { ZorkerLogo } from '@/components/zorker-logo'
import { useT } from '@/lib/i18n/client'
import { theme } from '@/lib/theme'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { createClient } from '@/utils/supabase/client'

interface HomeUser {
  email: string | null
  name: string | null
}

type FooterLink = { label: string; href: string; external?: boolean }

const footerGroups: Array<{ title: string; links: FooterLink[] }> = [
  {
    title: 'Product',
    links: [
      { label: 'Hydite', href: 'https://hydite.com', external: true },
      { label: 'Zorker', href: 'https://zorker.tech', external: true },
    ],
  },
  {
    title: 'Company',
    links: [{ label: 'Haokir', href: 'https://haokir.com', external: true }],
  },
  {
    title: 'Social',
    links: [{ label: 'X', href: 'https://x.com/Zorker_Tech', external: true }],
  },
]

function Header({ user }: { user: HomeUser | null }) {
  const t = useT()
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [isSigningOut, setIsSigningOut] = useState(false)

  const handleSignOut = async () => {
    setIsSigningOut(true)
    await supabase.auth.signOut()
    router.refresh()
    setIsSigningOut(false)
  }

  return (
    <header className={`flex h-[50px] shrink-0 items-center justify-between border-b px-2 ${theme('canvas', 'softBorder')}`}>
      <a aria-label="Zorker home" className="flex h-10 w-9 items-center justify-center rounded-lg" href="#">
        <ZorkerLogo className="h-5 w-[34px]" />
      </a>

      {user ? (
        <div className="flex items-center gap-2">
          <a className={`hidden max-w-[180px] truncate rounded-md px-2 py-1 text-sm transition-colors hover:text-[var(--app-foreground)] sm:block ${theme('muted', 'hover')}`} href="/app" title={user.email ?? user.name ?? undefined}>
            {user.name ?? user.email ?? t('已登录')}
          </a>
          <button
            className={`flex h-8 items-center rounded-lg border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${theme('surface', 'border', 'hover')}`}
            disabled={isSigningOut}
            onClick={handleSignOut}
            type="button"
          >
            {isSigningOut ? t('退出中…') : t('退出')}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <a className={`flex h-8 items-center rounded-lg border px-3 text-sm font-medium transition-colors ${theme('surface', 'border', 'hover')}`} href="/login">
            {t('登录')}
          </a>
          <a className={`flex h-8 items-center rounded-lg border border-[var(--app-submit-background)] px-3 text-sm font-medium transition-colors ${theme('action', 'actionHover')}`} href="/register">
            {t('注册')}
          </a>
        </div>
      )}
    </header>
  )
}

function Footer() {
  return (
    <footer className="px-6 py-16">
      <div className="mx-auto flex min-h-[226px] max-w-[1400px] items-start justify-between gap-16 px-[60px] pt-6 pb-10">
        <a aria-label="Zorker home" className="flex h-8 items-center" href="#">
          <ZorkerLogo className="h-7 w-[95px]" variant="wordmark" />
        </a>
        <div className="grid flex-1 grid-cols-2 gap-12 sm:grid-cols-3 lg:max-w-[870px] lg:gap-[108px]">
          {footerGroups.map((group) => (
            <div key={group.title}>
              <h2 className="text-sm leading-5 font-medium text-[var(--app-foreground)]">{group.title}</h2>
              <ul className="mt-4 space-y-2.5">
                {group.links.map((link) => (
                  <li key={link.label}>
                    <a
                      className="inline-flex items-center gap-0.5 whitespace-nowrap text-sm leading-6 text-[var(--app-muted)] hover:text-[var(--app-foreground)]"
                      href={link.href}
                      rel={link.external ? 'noopener noreferrer' : undefined}
                      target={link.external ? '_blank' : undefined}
                    >
                      {link.label}
                      {link.external && <ExternalLink className="size-4" />}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </footer>
  )
}

export function OpenLinkHome({ user, composerContext }: { user: HomeUser | null; composerContext: ComposerContext | null }) {
  return (
    <div className={`flex min-h-screen flex-col overflow-x-hidden ${theme('canvas')}`}>
      <Header user={user} />
      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <PromptComposer composerContext={composerContext} user={user} />
      </main>
      <Footer />
    </div>
  )
}
