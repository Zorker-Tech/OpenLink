import { useEffect, useState, type ReactNode } from 'react'

import { OpenLinkMotionProvider } from '@/components/ui/motion-provider'
import { I18nProvider } from '@/lib/i18n/client'
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  type Locale,
} from '@/lib/i18n/locales'
import { LOCALE_COOKIE, loadMessages, type Messages } from '@/lib/i18n/messages'

function readLocaleCookie(): Locale | null {
  if (typeof document === 'undefined') return null
  const prefix = `${LOCALE_COOKIE}=`
  const entry = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))
  if (!entry) return null
  try {
    return normalizeLocale(decodeURIComponent(entry.slice(prefix.length)))
  } catch {
    return null
  }
}

export function resolveInitialLocale(): Locale {
  return (
    readLocaleCookie() ??
    normalizeLocale(typeof navigator === 'undefined' ? undefined : navigator.language) ??
    DEFAULT_LOCALE
  )
}

export async function loadInitialMessages(): Promise<{ locale: Locale; messages: Messages }> {
  const locale = resolveInitialLocale()
  return { locale, messages: await loadMessages(locale) }
}

export function DesktopProviders({
  locale: initialLocale,
  messages: initialMessages,
  children,
}: {
  locale: Locale
  messages: Messages
  children: ReactNode
}) {
  const [locale, setLocale] = useState(initialLocale)
  const [messages, setMessages] = useState(initialMessages)

  useEffect(() => {
    const onLocale = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail
      const next = normalizeLocale(detail)
      if (!next || next === locale) return
      void loadMessages(next).then((loaded) => {
        setLocale(next)
        setMessages(loaded)
      })
    }
    window.addEventListener('openlink:locale', onLocale)
    return () => window.removeEventListener('openlink:locale', onLocale)
  }, [locale])

  return (
    <OpenLinkMotionProvider>
      <I18nProvider locale={locale} messages={messages}>
        {children}
      </I18nProvider>
    </OpenLinkMotionProvider>
  )
}
