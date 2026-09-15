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

export interface BrowserSessionConnectionDescriptor {
  session: BrowserSessionState
  connection: {
    eventsUrl: string
    previewUrl?: string
    bridgeNonce?: string
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
  chatSessionId: string
  surface: 'native-preview' | 'chromium-stream'
  initialUrl?: string
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
  return payload
}

export async function deleteBrowserSession(chatSessionId: string, browserSessionId: string): Promise<void> {
  const response = await fetch(`/api/browser/sessions/${encodeURIComponent(browserSessionId)}?chatSessionId=${encodeURIComponent(chatSessionId)}`, { method: 'DELETE' })
  if (!response.ok && response.status !== 404) throw new Error(`Browser session cleanup failed (${response.status})`)
}
