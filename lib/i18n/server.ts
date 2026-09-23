import 'server-only'

import { cookies, headers } from 'next/headers'

import { getUserPreferences } from '@/lib/user-preferences.server'
import { createClient } from '@/utils/supabase/server'

import { DEFAULT_LOCALE, localeFromAcceptLanguage, type Locale } from './locales'
import { LOCALE_COOKIE, createTranslator, loadMessages, readLocaleCookieValue } from './messages'

export { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from './messages'

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>

/** Cookie first: it is what the settings action and the language menu keep in sync. */
async function cookieLocale(): Promise<Locale | null> {
  const cookieStore = await cookies()
  const value = cookieStore.get(LOCALE_COOKIE)?.value
  return value ? readLocaleCookieValue(value) : null
}

export async function localeForUser(supabase: ServerSupabaseClient, userId: string): Promise<Locale> {
  const fromCookie = await cookieLocale()
  if (fromCookie) return fromCookie
  const preferences = await getUserPreferences(supabase, userId)
  return preferences.locale
}

/**
 * Resolves the locale for a server render.
 *
 * Order: the preference cookie (kept in sync when a user picks a language), the
 * stored user preference, then `Accept-Language`, then Simplified Chinese.
 */
export async function resolveLocale(): Promise<Locale> {
  const fromCookie = await cookieLocale()
  if (fromCookie) return fromCookie

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (user) return localeForUser(supabase, user.id)
  } catch {
    // Signed-out or not-yet-provisioned deployments fall through to the header.
  }

  const headerStore = await headers()
  return localeFromAcceptLanguage(headerStore.get('accept-language')) ?? DEFAULT_LOCALE
}

/**
 * Translator for server components and route handlers.
 *
 * `getT()` reads the live request (cookie → preference → header) on every call,
 * so concurrent requests for different users can never share a cached locale.
 */
export async function getT() {
  const locale = await resolveLocale()
  const messages = await loadMessages(locale)
  return { locale, t: createTranslator(messages) }
}
