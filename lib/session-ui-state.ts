'use client'

import { useEffect, useRef, useState, useCallback } from 'react'

export type SessionWorkspaceTab = 'preview' | 'realtime' | 'desktop' | 'code' | 'database'
export type SessionWorkspaceView = 'mobile' | 'browser' | 'desktop' | 'code' | 'data'
export type SessionBrowserSurface = 'native-preview' | 'chromium-stream'

export interface SessionUiState {
  version: 1
  openWorkspaceTabs: SessionWorkspaceTab[]
  workspaceView: SessionWorkspaceView
  dataSurface: 'panel' | 'studio'
  browserSurface: SessionBrowserSurface
  browserAddress: string
  previewTargetId: string | null
  selectedGitRef: string | null
  chatPanelCollapsed: boolean
  composerDraft: string
}

export const DEFAULT_SESSION_UI_STATE: SessionUiState = {
  version: 1,
  openWorkspaceTabs: ['preview'],
  workspaceView: 'browser',
  dataSurface: 'panel',
  browserSurface: 'native-preview',
  browserAddress: '',
  previewTargetId: null,
  selectedGitRef: null,
  chatPanelCollapsed: false,
  composerDraft: '',
}

const TABS = new Set<SessionWorkspaceTab>(['preview', 'realtime', 'desktop', 'code', 'database'])
const VIEWS = new Set<SessionWorkspaceView>(['mobile', 'browser', 'desktop', 'code', 'data'])
const SURFACES = new Set<SessionBrowserSurface>(['native-preview', 'chromium-stream'])

function storageKey(sessionId: string): string {
  return `openlink:session-ui:v1:${sessionId}`
}

function safeString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

export function sanitizeSessionUiState(value: unknown): SessionUiState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_SESSION_UI_STATE
  const raw = value as Record<string, unknown>
  const tabs = Array.isArray(raw.openWorkspaceTabs)
    ? raw.openWorkspaceTabs.filter((tab): tab is SessionWorkspaceTab => typeof tab === 'string' && TABS.has(tab as SessionWorkspaceTab))
    : []
  return {
    version: 1,
    openWorkspaceTabs: tabs.length ? [...new Set(tabs)] : [...DEFAULT_SESSION_UI_STATE.openWorkspaceTabs],
    workspaceView: typeof raw.workspaceView === 'string' && VIEWS.has(raw.workspaceView as SessionWorkspaceView)
      ? raw.workspaceView as SessionWorkspaceView
      : DEFAULT_SESSION_UI_STATE.workspaceView,
    dataSurface: raw.dataSurface === 'studio' ? 'studio' : 'panel',
    browserSurface: typeof raw.browserSurface === 'string' && SURFACES.has(raw.browserSurface as SessionBrowserSurface)
      ? raw.browserSurface as SessionBrowserSurface
      : DEFAULT_SESSION_UI_STATE.browserSurface,
    browserAddress: safeString(raw.browserAddress, 8192),
    previewTargetId: typeof raw.previewTargetId === 'string' && /^[A-Za-z0-9_-]{1,160}:[0-9]{1,5}$/.test(raw.previewTargetId) ? raw.previewTargetId : null,
    selectedGitRef: typeof raw.selectedGitRef === 'string' && raw.selectedGitRef.length <= 256 ? raw.selectedGitRef : null,
    chatPanelCollapsed: raw.chatPanelCollapsed === true,
    composerDraft: safeString(raw.composerDraft, 10_000),
  }
}

export function loadSessionUiState(sessionId: string): SessionUiState {
  if (typeof window === 'undefined') return DEFAULT_SESSION_UI_STATE
  try {
    const raw = window.sessionStorage.getItem(storageKey(sessionId))
    return raw ? sanitizeSessionUiState(JSON.parse(raw)) : DEFAULT_SESSION_UI_STATE
  } catch {
    return DEFAULT_SESSION_UI_STATE
  }
}

export function saveSessionUiState(sessionId: string, state: SessionUiState): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(storageKey(sessionId), JSON.stringify({ ...state, version: 1 }))
  } catch {
    // Storage can be unavailable in private/hardened browsing modes. Runtime
    // behavior must not depend on persistence succeeding.
  }
}

export function useSessionUiState(sessionId: string) {
  const [state, setState] = useState<SessionUiState>(DEFAULT_SESSION_UI_STATE)
  const [ready, setReady] = useState(false)
  const hydrated = useRef(false)

  useEffect(() => {
    hydrated.current = false
    setReady(false)
    setState(loadSessionUiState(sessionId))
    hydrated.current = true
    setReady(true)
  }, [sessionId])

  const update = useCallback((patch: Partial<Omit<SessionUiState, 'version'>>) => {
    if (!hydrated.current) return
    setState((current) => {
      const next = { ...current, ...patch, version: 1 as const }
      saveSessionUiState(sessionId, next)
      return next
    })
  }, [sessionId])

  return { state, update, ready }
}
