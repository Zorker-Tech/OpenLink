export interface UserPreferences {
  theme: 'system' | 'light' | 'dark'
  locale: 'zh-CN' | 'en-US'
  chatPosition: 'left' | 'right'
  customInstructions: string
}
