'use client'

import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { MotionConfig } from 'motion/react'
import type { UserPreferences } from '@/lib/user-preference-types'

export type OpenLinkTheme = 'light' | 'dark'
export type OpenLinkThemeAttribute = { 'data-openlink-theme'?: OpenLinkTheme }

const OpenLinkThemeContext = createContext<OpenLinkTheme | undefined>(undefined)

export function OpenLinkThemeProvider({ children, theme }: { children: ReactNode; theme: OpenLinkTheme }) {
  return (
    <MotionConfig reducedMotion="user">
      <OpenLinkThemeContext.Provider value={theme}>{children}</OpenLinkThemeContext.Provider>
    </MotionConfig>
  )
}

export function useOpenLinkTheme(explicitTheme?: OpenLinkTheme) {
  // Hooks run unconditionally: read the context before the explicit override
  // is allowed to short-circuit it.
  const contextTheme = useContext(OpenLinkThemeContext)
  return explicitTheme ?? contextTheme
}

export function useDisplayModeSync(setMode: (mode: UserPreferences['theme']) => void) {
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key !== 'openlink-theme') return
      const mode = event.newValue
      if (mode === 'light' || mode === 'dark' || mode === 'system') setMode(mode)
    }
    window.addEventListener('storage', update)
    return () => window.removeEventListener('storage', update)
  }, [setMode])
}
