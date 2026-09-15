'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { MotionConfig } from 'motion/react'

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
  return explicitTheme ?? useContext(OpenLinkThemeContext)
}
