import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import {
  BROWSER_PROTOCOL_VERSION,
  type BrowserActionEnvelope,
  type BrowserActionResult,
  type BrowserControlOwner,
  type BrowserEvent,
  type BrowserEventEnvelope,
  type BrowserSessionState,
  type BrowserSurfaceKind,
} from '@openlink/browser-protocol'
import { BrowserHostError, toBrowserHostError } from './errors.js'

export interface BrowserRuntimeSession {
  readonly surface: BrowserSurfaceKind
  start(): Promise<void>
  perform(envelope: BrowserActionEnvelope): Promise<BrowserActionResult>
  resolveBridgeResult?(commandId: string, result: BrowserActionResult): void
  close(): Promise<void>
}

export interface BrowserSessionRuntimeContext {
  sessionId: string
  ownerId: string
  workspaceId: string
  projectId: string
  emit(event: BrowserEvent): BrowserEventEnvelope
  update(mutator: (state: BrowserSessionState) => BrowserSessionState): BrowserSessionState
  getState(): BrowserSessionState
}

export type BrowserRuntimeFactory = (context: BrowserSessionRuntimeContext) => BrowserRuntimeSession

export interface CreateManagedSessionInput {
  ownerId: string
  workspaceId: string
  projectId: string
  surface: BrowserSurfaceKind
  viewport?: BrowserSessionState['viewport']
  runtimeFactory: BrowserRuntimeFactory
}

interface ManagedSession {
  state: BrowserSessionState
  runtime: BrowserRuntimeSession
  sequence: number
  events: BrowserEventEnvelope[]
  emitter: EventEmitter
  cleanupTimer: NodeJS.Timeout
}

const MAX_REPLAY_EVENTS = 512

function createSessionId(): string {
  return randomBytes(18).toString('base64url')
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString()
}

export class BrowserSessionManager {
  private readonly sessions = new Map<string, ManagedSession>()

  constructor(
    private readonly options: {
      maxSessions: number
      sessionTtlMs: number
      controlLeaseTtlMs: number
      now?: () => number
    },
  ) {}

  private get now(): () => number {
    return this.options.now ?? Date.now
  }

  async create(input: CreateManagedSessionInput): Promise<BrowserSessionState> {
    if (this.sessions.size >= this.options.maxSessions) {
      throw new BrowserHostError('SESSION_LIMIT_REACHED', 'Browser session limit reached', 429, true)
    }
    if (!input.ownerId || !input.workspaceId) throw new BrowserHostError('INVALID_SESSION', 'ownerId and workspaceId are required', 400)

    const id = createSessionId()
    const createdAt = nowIso(this.now)
    const state: BrowserSessionState = {
      version: BROWSER_PROTOCOL_VERSION,
      id,
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      surface: input.surface,
      status: 'starting',
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(this.now() + this.options.sessionTtlMs).toISOString(),
      controlOwner: null,
      pages: [],
      viewport: input.viewport ?? { width: 1280, height: 800, deviceScaleFactor: 1 },
      capabilities: {
        nativeDom: input.surface !== 'chromium-stream',
        screencast: input.surface === 'chromium-stream',
        componentInspection: true,
        downloads: true,
        uploads: true,
        dialogs: true,
        devtools: input.surface !== 'native-preview',
      },
    }

    const emitter = new EventEmitter()
    emitter.setMaxListeners(100)
    let managed!: ManagedSession
    const context: BrowserSessionRuntimeContext = {
      sessionId: id,
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      emit: (event) => this.emit(id, event),
      update: (mutator) => {
        const current = this.require(id)
        current.state = { ...mutator(current.state), updatedAt: nowIso(this.now) }
        this.emit(id, { type: 'session.state', state: current.state })
        return current.state
      },
      getState: () => this.require(id).state,
    }
    const runtime = input.runtimeFactory(context)
    managed = {
      state,
      runtime,
      sequence: 0,
      events: [],
      emitter,
      cleanupTimer: setTimeout(() => void this.close(id), this.options.sessionTtlMs),
    }
    managed.cleanupTimer.unref()
    this.sessions.set(id, managed)
    this.emit(id, { type: 'session.state', state })

    try {
      await runtime.start()
      const current = this.require(id)
      if (current.state.status === 'starting') {
        current.state = { ...current.state, status: 'ready', updatedAt: nowIso(this.now) }
        this.emit(id, { type: 'session.state', state: current.state })
      }
      return current.state
    } catch (error) {
      const failure = toBrowserHostError(error)
      const errorPayload = { code: failure.code, message: failure.message, recoverable: failure.recoverable }
      managed.state = {
        ...managed.state,
        status: 'failed',
        updatedAt: nowIso(this.now),
        error: errorPayload,
      }
      this.emit(id, { type: 'runtime.error', error: errorPayload })
      await runtime.close().catch(() => undefined)
      throw failure
    }
  }

  get(sessionId: string, ownerId?: string): BrowserSessionState {
    const session = this.require(sessionId)
    if (ownerId && session.state.ownerId !== ownerId) throw new BrowserHostError('SESSION_NOT_FOUND', 'Browser session not found', 404)
    this.releaseExpiredLease(session)
    return session.state
  }

  list(ownerId?: string): BrowserSessionState[] {
    return [...this.sessions.values()]
      .filter((session) => !ownerId || session.state.ownerId === ownerId)
      .map((session) => session.state)
  }

  async perform(envelope: BrowserActionEnvelope): Promise<BrowserActionResult> {
    const session = this.require(envelope.sessionId)
    if (session.state.status !== 'ready') throw new BrowserHostError('SESSION_NOT_READY', 'Browser session is not ready', 409, true)

    if (envelope.action.type === 'control.acquire') {
      if (envelope.action.owner !== envelope.actor) throw new BrowserHostError('CONTROL_ACTOR_MISMATCH', 'Control owner must match the action actor', 403)
      this.acquireControl(session, envelope.action.owner, envelope.action.ttlMs)
      return this.success(envelope)
    }
    if (envelope.action.type === 'control.release') {
      if (envelope.action.owner !== envelope.actor) throw new BrowserHostError('CONTROL_ACTOR_MISMATCH', 'Control owner must match the action actor', 403)
      this.releaseControl(session, envelope.action.owner)
      return this.success(envelope)
    }

    this.ensureControl(session, envelope.actor)
    try {
      const result = await session.runtime.perform(envelope)
      this.emit(envelope.sessionId, { type: 'action.result', result })
      return result
    } catch (error) {
      const failure = toBrowserHostError(error)
      const result: BrowserActionResult = {
        version: BROWSER_PROTOCOL_VERSION,
        actionId: envelope.actionId,
        sessionId: envelope.sessionId,
        ok: false,
        error: { code: failure.code, message: failure.message, recoverable: failure.recoverable },
      }
      this.emit(envelope.sessionId, { type: 'action.result', result })
      return result
    }
  }

  subscribe(sessionId: string, listener: (event: BrowserEventEnvelope) => void, afterSequence = 0): () => void {
    const session = this.require(sessionId)
    for (const event of session.events) {
      if (event.sequence > afterSequence) listener(event)
    }
    session.emitter.on('event', listener)
    return () => session.emitter.off('event', listener)
  }

  replay(sessionId: string, afterSequence = 0): BrowserEventEnvelope[] {
    return this.require(sessionId).events.filter((event) => event.sequence > afterSequence)
  }

  resolveBridgeResult(sessionId: string, commandId: string, result: BrowserActionResult): void {
    const runtime = this.require(sessionId).runtime
    if (!runtime.resolveBridgeResult) throw new BrowserHostError('BRIDGE_NOT_AVAILABLE', 'Session does not accept bridge results', 409)
    runtime.resolveBridgeResult(commandId, result)
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    clearTimeout(session.cleanupTimer)
    session.state = { ...session.state, status: 'closing', updatedAt: nowIso(this.now) }
    this.emit(sessionId, { type: 'session.state', state: session.state })
    try {
      await session.runtime.close()
      session.state = { ...session.state, status: 'closed', updatedAt: nowIso(this.now) }
      this.emit(sessionId, { type: 'session.state', state: session.state })
    } finally {
      session.emitter.removeAllListeners()
      this.sessions.delete(sessionId)
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)))
  }

  private require(sessionId: string): ManagedSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new BrowserHostError('SESSION_NOT_FOUND', 'Browser session not found', 404)
    return session
  }

  private emit(sessionId: string, event: BrowserEvent): BrowserEventEnvelope {
    const session = this.require(sessionId)
    const envelope: BrowserEventEnvelope = {
      version: BROWSER_PROTOCOL_VERSION,
      sessionId,
      sequence: ++session.sequence,
      timestamp: nowIso(this.now),
      event,
    }
    session.events.push(envelope)
    if (session.events.length > MAX_REPLAY_EVENTS) session.events.splice(0, session.events.length - MAX_REPLAY_EVENTS)
    session.emitter.emit('event', envelope)
    return envelope
  }

  private releaseExpiredLease(session: ManagedSession): void {
    const expiresAt = session.state.controlLeaseExpiresAt ? Date.parse(session.state.controlLeaseExpiresAt) : 0
    if (session.state.controlOwner && expiresAt <= this.now()) {
      session.state = { ...session.state, controlOwner: null, controlLeaseExpiresAt: undefined, updatedAt: nowIso(this.now) }
      this.emit(session.state.id, { type: 'session.state', state: session.state })
    }
  }

  private acquireControl(session: ManagedSession, owner: Exclude<BrowserControlOwner, null>, ttlMs?: number): void {
    this.releaseExpiredLease(session)
    const current = session.state.controlOwner
    if (current && current !== owner && !(owner === 'human' && current === 'agent')) {
      throw new BrowserHostError('CONTROL_LEASE_HELD', `Browser control is held by ${current}`, 409, true)
    }
    const effectiveTtl = Math.min(Math.max(ttlMs ?? this.options.controlLeaseTtlMs, 1_000), 120_000)
    session.state = {
      ...session.state,
      controlOwner: owner,
      controlLeaseExpiresAt: new Date(this.now() + effectiveTtl).toISOString(),
      updatedAt: nowIso(this.now),
    }
    this.emit(session.state.id, { type: 'session.state', state: session.state })
  }

  private releaseControl(session: ManagedSession, owner: Exclude<BrowserControlOwner, null>): void {
    this.releaseExpiredLease(session)
    if (session.state.controlOwner && session.state.controlOwner !== owner) {
      throw new BrowserHostError('CONTROL_LEASE_HELD', `Browser control is held by ${session.state.controlOwner}`, 409, true)
    }
    session.state = { ...session.state, controlOwner: null, controlLeaseExpiresAt: undefined, updatedAt: nowIso(this.now) }
    this.emit(session.state.id, { type: 'session.state', state: session.state })
  }

  private ensureControl(session: ManagedSession, actor: Exclude<BrowserControlOwner, null>): void {
    this.releaseExpiredLease(session)
    if (!session.state.controlOwner || (actor === 'human' && session.state.controlOwner === 'agent')) {
      this.acquireControl(session, actor)
      return
    }
    if (session.state.controlOwner !== actor) {
      throw new BrowserHostError('CONTROL_LEASE_HELD', `Browser control is held by ${session.state.controlOwner}`, 409, true)
    }
    this.acquireControl(session, actor)
  }

  private success(envelope: BrowserActionEnvelope): BrowserActionResult {
    const result: BrowserActionResult = {
      version: BROWSER_PROTOCOL_VERSION,
      actionId: envelope.actionId,
      sessionId: envelope.sessionId,
      ok: true,
    }
    this.emit(envelope.sessionId, { type: 'action.result', result })
    return result
  }
}
