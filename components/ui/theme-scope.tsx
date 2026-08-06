'use client'

import { createContext, useContext, type ReactNode } from 'react'

export type OpenLinkTheme = 'light' | 'dark'
export type OpenLinkThemeAttribute = { 'data-openlink-theme'?: OpenLinkTheme }

const OpenLinkThemeContext = createContext<OpenLinkTheme | undefined>(undefined)

export function OpenLinkThemeProvider({ children, theme }: { children: ReactNode; theme: OpenLinkTheme }) {
  return <OpenLinkThemeContext.Provider value={theme}>{children}</OpenLinkThemeContext.Provider>
}

export function useOpenLinkTheme(explicitTheme?: OpenLinkTheme) {
  return explicitTheme ?? useContext(OpenLinkThemeContext)
}
