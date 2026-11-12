'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { isPreviewTargetId } from '@/lib/browser-preview-target-id'

export type SessionWorkspaceTab = 'preview' | 'realtime' | 'desktop' | 'code' | 'database'
export type SessionWorkspaceView = 'mobile' | 'browser' | 'desktop' | 'code' | 'data'
export type SessionBrowserSurface = 'native-preview' | 'chromium-stream'

export interface SessionUiState {
  version: 2
  openWorkspaceTabs: SessionWorkspaceTab[]
  workspaceView: SessionWorkspaceView
  dataSurface: 'panel' | 'studio'
  browserSurface: SessionBrowserSurface
  browserAddress: string
  previewProjectId: string | null
  previewTargetId: string | null
  selectedGitRef: string | null
  chatPanelCollapsed: boolean
  composerDraft: string
}

export const DEFAULT_SESSION_UI_STATE: SessionUiState = {
  version: 2,
  openWorkspaceTabs: ['desktop'],
  workspaceView: 'desktop',
  dataSurface: 'panel',
  browserSurface: 'native-preview',
  browserAddress: '',
  previewProjectId: null,
  previewTargetId: null,
  selectedGitRef: null,
  chatPanelCollapsed: false,
  composerDraft: '',
}

const TABS = new Set<SessionWorkspaceTab>(['preview', 'realtime', 'desktop', 'code', 'database'])
const VIEWS = new Set<SessionWorkspaceView>(['mobile', 'browser', 'desktop', 'code', 'data'])
const SURFACES = new Set<SessionBrowserSurface>(['native-preview', 'chromium-stream'])
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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
  const storedView = typeof raw.workspaceView === 'string' && VIEWS.has(raw.workspaceView as SessionWorkspaceView)
    ? raw.workspaceView as SessionWorkspaceView
    : null
  // Earlier builds opened Preview by default. Move that untouched default to
  // Desktop once; sessions that deliberately chose another tab are preserved.
  const migrateLegacyDefault = raw.version !== 2
    && tabs.length === 1
    && tabs[0] === 'preview'
    && (storedView === 'browser' || storedView === 'mobile')
  return {
    version: 2,
    openWorkspaceTabs: migrateLegacyDefault
      ? ['desktop']
      : tabs.length ? [...new Set(tabs)] : [...DEFAULT_SESSION_UI_STATE.openWorkspaceTabs],
    workspaceView: migrateLegacyDefault
      ? 'desktop'
      : storedView ?? DEFAULT_SESSION_UI_STATE.workspaceView,
    dataSurface: raw.dataSurface === 'studio' ? 'studio' : 'panel',
    browserSurface: typeof raw.browserSurface === 'string' && SURFACES.has(raw.browserSurface as SessionBrowserSurface)
      ? raw.browserSurface as SessionBrowserSurface
      : DEFAULT_SESSION_UI_STATE.browserSurface,
    browserAddress: safeString(raw.browserAddress, 8192),
    previewProjectId: typeof raw.previewProjectId === 'string' && PROJECT_ID_PATTERN.test(raw.previewProjectId)
      ? raw.previewProjectId
      : null,
    previewTargetId: isPreviewTargetId(raw.previewTargetId) ? raw.previewTargetId : null,
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
    window.sessionStorage.setItem(storageKey(sessionId), JSON.stringify({ ...state, version: 2 }))
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
      const next = { ...current, ...patch, version: 2 as const }
      saveSessionUiState(sessionId, next)
      return next
    })
  }, [sessionId])

  return { state, update, ready }
}
