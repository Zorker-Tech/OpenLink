'use client'

import {
  BROWSER_PROTOCOL_VERSION,
  type BrowserAction,
  type BrowserActionEnvelope,
  type BrowserActionResult,
  type BrowserControlOwner,
  type BrowserEventEnvelope,
  type BrowserSessionState,
  type BrowserSocketServerMessage,
} from '@/packages/browser-protocol/src/index'
import { isPreviewTargetId } from '@/lib/browser-preview-target-id'
import { isPreviewSourceRevision } from '@/packages/browser-protocol/src/index'

export interface BrowserPreviewTarget {
  id: string
  label: string
  port: number
  source?: 'sandbox' | 'worktree'
  gitRef?: string
  targetRevision?: string
}

export interface BrowserSessionConnectionDescriptor {
  session: BrowserSessionState
  connection: {
    eventsUrl: string
    previewUrl?: string
    bridgeNonce?: string
  }
  /** Active development server this surface attached to, when known. */
  previewTarget?: BrowserPreviewTarget
}

// Local capability gateways are served through Next.js on the same origin as
// the page. This keeps WebSocket upgrades and SameSite cookies working whether
// the user opened OpenLink through localhost or a LAN address.
const REWRITABLE_GATEWAY_HOST = /^(?:localhost|\[::1\]|\d{1,3}(?:\.\d{1,3}){3})$/i

/**
 * Desktop hosts inject this marker. A remote/cloud profile talks to a gateway
 * owned by another machine, so rewriting its IP to the desktop's own hostname
 * would point the preview at the wrong computer.
 */
function desktopProfileKind(): string | null {
  if (typeof document === 'undefined') return null
  return (
    document
      .querySelector('meta[name="openlink-desktop-profile-kind"]')
      ?.getAttribute('content')
      ?.trim() || null
  )
}

/** Route local gateway URLs through the current page's same-origin gateway paths. */
export function browserReachableGatewayUrl(value: string): string {
  if (typeof window === 'undefined') return value
  const profileKind = desktopProfileKind()
  if (profileKind && profileKind !== 'local') return value
  try {
    const url = new URL(value)
    if (!REWRITABLE_GATEWAY_HOST.test(url.hostname)) return value
    // The Next.js server forwards these paths to the local capability proxy.
    // Use the page's complete authority so LAN, localhost, and custom ports
    // all reach the same server that served the app.
    const isWebSocket = url.protocol === 'ws:' || url.protocol === 'wss:'
    if (isWebSocket) {
      url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    } else {
      url.protocol = window.location.protocol
    }
    url.host = window.location.host
    return url.toString()
  } catch {
    return value
  }
}

export type BrowserConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'failed'

export class BrowserSessionCreateError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly recoverable: boolean,
  ) {
    super(message)
    this.name = 'BrowserSessionCreateError'
  }
}

export class BrowserConnection {
  private socket?: WebSocket
  private closed = false
  private reconnectAttempt = 0
  private reconnectTimer?: number
  private heartbeatTimer?: number
  private sequence = 0
  private statusListeners = new Set<(status: BrowserConnectionStatus) => void>()
  private eventListeners = new Set<(event: BrowserEventEnvelope) => void>()
  private latestScreencasts = new Map<string, BrowserEventEnvelope>()
  private stateListeners = new Set<(state: BrowserSessionState) => void>()
  private errorListeners = new Set<(message: string) => void>()
  private sessionLostListeners = new Set<(reason: string) => void>()
  private sessionLostNotified = false
  private _state: BrowserSessionState

  constructor(readonly descriptor: BrowserSessionConnectionDescriptor) {
    this._state = descriptor.session
  }

  get state(): BrowserSessionState {
    return this._state
  }

  connect(): void {
    if (this.closed || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return
    this.emitStatus(this.reconnectAttempt ? 'reconnecting' : 'connecting')
    const socket = new WebSocket(this.descriptor.connection.eventsUrl)
    this.socket = socket
    socket.addEventListener('open', () => {
      this.reconnectAttempt = 0
      this.emitStatus('connected')
      socket.send(JSON.stringify({ type: 'subscribe', afterSequence: this.sequence }))
      if (this.heartbeatTimer !== undefined) window.clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = window.setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return
        socket.send(JSON.stringify({ type: 'ping', nonce: `${Date.now()}-${Math.random().toString(36).slice(2)}` }))
      }, 15_000)
    })
    socket.addEventListener('message', (event) => this.handleMessage(event.data))
    socket.addEventListener('error', () => this.emitError('Browser connection encountered a transport error'))
    socket.addEventListener('close', (event) => {
      if (this.socket === socket) this.socket = undefined
      if (this.heartbeatTimer !== undefined) {
        window.clearInterval(this.heartbeatTimer)
        this.heartbeatTimer = undefined
      }
      if (this.closed || event.code === 1000) {
        this.emitStatus('closed')
        return
      }
      this.scheduleReconnect()
    })
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer)
    if (this.heartbeatTimer !== undefined) window.clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    this.socket?.close(1000, 'Client closed')
    this.socket = undefined
    this.emitStatus('closed')
  }

  sendAction(action: BrowserAction, actor: Exclude<BrowserControlOwner, null> = 'human'): string {
    const actionId = crypto.randomUUID()
    const envelope: BrowserActionEnvelope = {
      version: BROWSER_PROTOCOL_VERSION,
      actionId,
      sessionId: this._state.id,
      actor,
      action,
    }
    this.send({ type: 'action', payload: envelope })
    return actionId
  }

  sendBridgeResult(commandId: string, result: BrowserActionResult): void {
    this.send({ type: 'bridge.result', commandId, result })
  }

  onStatus(listener: (status: BrowserConnectionStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  onEvent(listener: (event: BrowserEventEnvelope) => void): () => void {
    this.eventListeners.add(listener)
    // The first Chromium frame often arrives while the BrowserWorkbench is
    // mounting the stream surface. Replay the most recent frame to late
    // subscribers so the realtime canvas never stays on an empty image.
    for (const event of this.latestScreencasts.values()) listener(event)
    return () => this.eventListeners.delete(listener)
  }

  onState(listener: (state: BrowserSessionState) => void): () => void {
    this.stateListeners.add(listener)
    listener(this._state)
    return () => this.stateListeners.delete(listener)
  }

  onError(listener: (message: string) => void): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  onSessionLost(listener: (reason: string) => void): () => void {
    this.sessionLostListeners.add(listener)
    return () => this.sessionLostListeners.delete(listener)
  }

  private send(message: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Browser connection is not ready')
    this.socket.send(JSON.stringify(message))
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return
    let message: BrowserSocketServerMessage
    try { message = JSON.parse(raw) as BrowserSocketServerMessage } catch { return }
    if (message.type === 'snapshot') {
      this.sequence = Math.max(this.sequence, message.sequence)
      this.updateState(message.payload)
      return
    }
    if (message.type === 'error') {
      this.emitError(message.error.message)
      if (message.error.code === 'SESSION_NOT_FOUND' || message.error.code === 'TOKEN_EXPIRED') {
        this.emitSessionLost(message.error.message)
      }
      return
    }
    if (message.type !== 'event') return
    if (message.payload.sessionId !== this._state.id) return
    // The server may replay the latest screencast after the snapshot. Its
    // sequence is older than the snapshot cursor by design, but the frame is
    // still the authoritative current visual state and must be delivered to a
    // surface that mounted after Chromium emitted it.
    if (message.payload.event.type === 'page.screencast') {
      this.sequence = Math.max(this.sequence, message.payload.sequence)
      this.latestScreencasts.set(message.payload.event.pageId, message.payload)
      for (const listener of this.eventListeners) listener(message.payload)
      return
    }
    if (message.payload.sequence <= this.sequence) return
    this.sequence = message.payload.sequence
    if (message.payload.event.type === 'session.state') this.updateState(message.payload.event.state)
    if (message.payload.event.type === 'page.state') {
      const page = message.payload.event.page
      const exists = this._state.pages.some((current) => current.id === page.id)
      this.updateState({ ...this._state, pages: exists ? this._state.pages.map((current) => current.id === page.id ? page : current) : [...this._state.pages, page] })
    }
    if (message.payload.event.type === 'page.closed') {
      const pageId = message.payload.event.pageId
      this.latestScreencasts.delete(pageId)
      this.updateState({ ...this._state, pages: this._state.pages.filter((page) => page.id !== pageId) })
    }
    for (const listener of this.eventListeners) listener(message.payload)
  }

  private updateState(state: BrowserSessionState): void {
    this._state = state
    for (const listener of this.stateListeners) listener(state)
    if (state.status === 'closed' || state.status === 'failed') {
      this.emitSessionLost(state.error?.message || `Browser session ${state.status}`)
    }
  }

  private emitSessionLost(reason: string): void {
    if (this.sessionLostNotified) return
    this.sessionLostNotified = true
    for (const listener of this.sessionLostListeners) listener(reason)
  }

  private scheduleReconnect(): void {
    if (this.closed) return
    if (this.reconnectAttempt >= 8) {
      this.emitStatus('failed')
      this.emitError('Browser connection could not be restored')
      this.emitSessionLost('Browser connection could not be restored')
      return
    }
    this.reconnectAttempt += 1
    this.emitStatus('reconnecting')
    const delay = Math.min(10_000, 250 * 2 ** (this.reconnectAttempt - 1)) + Math.floor(Math.random() * 200)
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay)
  }

  private emitStatus(status: BrowserConnectionStatus): void {
    for (const listener of this.statusListeners) listener(status)
  }

  private emitError(message: string): void {
    for (const listener of this.errorListeners) listener(message)
  }
}

export async function createBrowserSession(input: {
  chatSessionId?: string
  projectId: string
  surface: 'native-preview' | 'chromium-stream'
  initialUrl?: string
  previewTargetId?: string
  viewport?: { width: number; height: number; deviceScaleFactor: number }
}): Promise<BrowserSessionConnectionDescriptor> {
  const response = await fetch('/api/browser/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const payload = await response.json() as BrowserSessionConnectionDescriptor & { error?: { code?: string; message?: string; recoverable?: boolean } }
  if (!response.ok) {
    throw new BrowserSessionCreateError(
      payload.error?.message || `Browser session failed (${response.status})`,
      payload.error?.code || 'BROWSER_SESSION_FAILED',
      response.status,
      payload.error?.recoverable === true,
    )
  }
  return {
    ...payload,
    connection: {
      ...payload.connection,
      eventsUrl: browserReachableGatewayUrl(payload.connection.eventsUrl),
      ...(payload.connection.previewUrl
        ? { previewUrl: browserReachableGatewayUrl(payload.connection.previewUrl) }
        : {}),
    },
  }
}

export async function listBrowserPreviewTargets(input: { projectId: string; chatSessionId?: string }): Promise<BrowserPreviewTarget[]> {
  const query = new URLSearchParams({ projectId: input.projectId })
  if (input.chatSessionId) query.set('chatSessionId', input.chatSessionId)
  const response = await fetch(`/api/browser/preview-targets?${query.toString()}`, { cache: 'no-store' })
  const payload = await response.json().catch(() => null) as { targets?: unknown; error?: { message?: string } } | null
  if (!response.ok) throw new Error(payload?.error?.message || `Preview discovery failed (${response.status})`)
  return Array.isArray(payload?.targets)
    ? payload.targets.flatMap((value) => {
        if (!value || typeof value !== 'object') return []
        const target = value as Record<string, unknown>
        return isPreviewTargetId(target.id) && typeof target.label === 'string' && typeof target.port === 'number'
          ? [{
              id: target.id,
              label: target.label,
              port: target.port,
            ...(target.source === 'worktree' ? { source: 'worktree' as const } : { source: 'sandbox' as const }),
            ...(typeof target.gitRef === 'string' && /^[0-9a-f]{40}$/i.test(target.gitRef) ? { gitRef: target.gitRef } : {}),
            ...(isPreviewSourceRevision(target.targetRevision)
              ? { targetRevision: target.targetRevision }
              : {}),
            }]
          : []
      })
    : []
}

export async function deleteBrowserSession(input: { projectId: string; chatSessionId?: string }, browserSessionId: string): Promise<void> {
  const query = new URLSearchParams({ projectId: input.projectId })
  if (input.chatSessionId) query.set('chatSessionId', input.chatSessionId)
  const response = await fetch(`/api/browser/sessions/${encodeURIComponent(browserSessionId)}?${query.toString()}`, { method: 'DELETE' })
  if (!response.ok && response.status !== 404) throw new Error(`Browser session cleanup failed (${response.status})`)
}
