import type { Locale } from '@/lib/i18n/locales'

export interface UserPreferences {
  theme: 'system' | 'light' | 'dark'
  locale: Locale
  chatPosition: 'left' | 'right'
  thinkingVisibility: 'summary' | 'hidden'
  customInstructions: string
}
