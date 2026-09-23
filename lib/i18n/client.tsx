'use client'

import { createContext, useContext, useMemo, type ReactNode } from 'react'

import { SOURCE_LOCALE, type Locale } from './locales'
import { createTranslator, type Messages, type Translator } from './messages'

interface I18nContextValue {
  locale: Locale
  messages: Messages
  t: Translator
}

const I18nContext = createContext<I18nContextValue | null>(null)

const sourceOnlyTranslator: Translator = createTranslator({})

/**
 * Locale + catalog for the current request.
 *
 * The locale arrives from the server (preference cookie), so the first paint
 * and the hydrated client render agree on every string — no post-mount swap
 * and no hydration mismatch.
 */
export function I18nProvider({ children, locale, messages }: { children: ReactNode; locale: Locale; messages: Messages }) {
  const value = useMemo<I18nContextValue>(() => ({
    locale,
    messages,
    t: createTranslator(messages),
  }), [locale, messages])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/**
 * Translator for client components.
 *
 * Falls back to a source-string translator so a component rendered outside the
 * provider (stories, isolated tests) still renders real copy.
 */
export function useT(): Translator {
  return useContext(I18nContext)?.t ?? sourceOnlyTranslator
}

export function useLocale(): Locale {
  return useContext(I18nContext)?.locale ?? SOURCE_LOCALE
}

export function useMessages(): Messages {
  return useContext(I18nContext)?.messages ?? {}
}
