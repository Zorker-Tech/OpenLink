import 'server-only'

import type { UserPreferences } from '@/lib/user-preference-types'
import { createClient } from '@/utils/supabase/server'

export type { UserPreferences } from '@/lib/user-preference-types'

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  theme: 'system',
  locale: 'zh-CN',
  chatPosition: 'left',
  thinkingVisibility: 'summary',
  customInstructions: '',
}

export async function getUserPreferences(supabase: ServerSupabaseClient, userId: string) {
  const { data, error } = await supabase
    .schema('openlink')
    .from('user_preferences')
    .select('theme, locale, chat_position, thinking_visibility, custom_instructions')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  if (!data) return DEFAULT_USER_PREFERENCES
  return {
    theme: data.theme as UserPreferences['theme'],
    locale: data.locale as UserPreferences['locale'],
    chatPosition: data.chat_position as UserPreferences['chatPosition'],
    thinkingVisibility: (data.thinking_visibility ?? 'summary') as UserPreferences['thinkingVisibility'],
    customInstructions: data.custom_instructions,
  }
}
