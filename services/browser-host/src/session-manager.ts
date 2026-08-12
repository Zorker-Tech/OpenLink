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
  /**
   * A runtime-owned resource identity. Chromium uses this for its persistent
   * profile directory, which must never be launched by two processes at once.
   */
  reuseKey?: string
  runtimeFactory: BrowserRuntimeFactory
}

interface ManagedSession {
  state: BrowserSessionState
  runtime: BrowserRuntimeSession
  sequence: number
  events: BrowserEventEnvelope[]
  latestScreencasts: Map<string, BrowserEventEnvelope>
  emitter: EventEmitter
  cleanupTimer: NodeJS.Timeout
  closePromise?: Promise<void>
  reuseKey?: string
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
  /** Serializes create/close operations for a persistent runtime resource. */
  private readonly resourceLocks = new Map<string, Promise<void>>()
  /** Reservations close the maxSessions race while runtime.start() awaits. */
  private creating = 0

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
    if (!input.reuseKey) return this.createUnlocked(input)
    return this.withResourceLock(input.reuseKey, async () => {
      // A duplicate create can be caused by an events-socket reconnect while
      // the previous view is still alive. Returning the existing session is
      // safe (new capability tokens are issued by BrowserHostServer) and,
      // crucially, avoids a second launchPersistentContext(profilePath).
      const existing = [...this.sessions.values()].find((candidate) =>
        candidate.reuseKey === input.reuseKey
        && candidate.state.surface === input.surface
        && (candidate.state.status === 'starting' || candidate.state.status === 'ready'),
      )
      if (existing) return existing.state
      return this.createUnlocked(input)
    })
  }

  private async createUnlocked(input: CreateManagedSessionInput): Promise<BrowserSessionState> {
    if (!input.ownerId || !input.workspaceId) throw new BrowserHostError('INVALID_SESSION', 'ownerId and workspaceId are required', 400)
    if (this.sessions.size + this.creating >= this.options.maxSessions) {
      throw new BrowserHostError('SESSION_LIMIT_REACHED', 'Browser session limit reached', 429, true)
    }
    this.creating += 1

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
    let runtime: BrowserRuntimeSession
    try {
      runtime = input.runtimeFactory(context)
    } catch (error) {
      this.creating -= 1
      throw error
    }
    managed = {
      state,
      runtime,
      sequence: 0,
      events: [],
      latestScreencasts: new Map(),
      emitter,
      cleanupTimer: setTimeout(() => { void this.close(id).catch(() => undefined) }, this.options.sessionTtlMs),
      reuseKey: input.reuseKey,
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
      try {
        await runtime.close()
        clearTimeout(managed.cleanupTimer)
        managed.emitter.removeAllListeners()
        this.sessions.delete(id)
      } catch (cleanupError) {
        // Startup failures can happen after Chromium/SSH has allocated
        // resources. Retain the failed entry and let the normal close/reaper
        // path retry cleanup instead of releasing the capacity slot while the
        // runtime is still alive.
        managed.closePromise = undefined
        managed.cleanupTimer = setTimeout(() => { void this.close(id).catch(() => undefined) }, this.options.sessionTtlMs)
        managed.cleanupTimer.unref()
        console.error(`OpenLink browser startup cleanup failed for ${id}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
      }
      throw failure
    } finally {
      this.creating -= 1
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

  /**
   * Keep a session alive while an authenticated events socket is open. The
   * timer remains idle-cleanup based: once the client disconnects and stops
   * sending pings, the normal TTL closes the browser and releases Chromium.
   */
  touch(sessionId: string): void {
    const session = this.require(sessionId)
    if (session.state.status !== 'ready') throw new BrowserHostError('SESSION_NOT_READY', 'Browser session is not ready', 409, true)
    clearTimeout(session.cleanupTimer)
    session.state = {
      ...session.state,
      expiresAt: new Date(this.now() + this.options.sessionTtlMs).toISOString(),
      updatedAt: nowIso(this.now),
    }
    session.cleanupTimer = setTimeout(() => { void this.close(sessionId).catch(() => undefined) }, this.options.sessionTtlMs)
    session.cleanupTimer.unref()
    // The Agent Host gateway tracks the Browser Host expiry from session.state
    // events. Emit the refreshed lease so a long-lived WebSocket heartbeat
    // cannot keep Chromium alive while the gateway binding expires at the
    // original TTL and loses the agent capability on reconnect.
    this.emit(sessionId, { type: 'session.state', state: session.state })
  }

  async perform(envelope: BrowserActionEnvelope): Promise<BrowserActionResult> {
    const session = this.require(envelope.sessionId)
    if (session.state.status !== 'ready') throw new BrowserHostError('SESSION_NOT_READY', 'Browser session is not ready', 409, true)
    // Agent actions are also activity. Without touching the session here, a
    // long-running automation with no human WebSocket pings can expire at the
    // fixed browser TTL while Chromium is still actively being controlled.
    this.touch(envelope.sessionId)

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

  latestScreencasts(sessionId: string): BrowserEventEnvelope[] {
    return [...this.require(sessionId).latestScreencasts.values()]
      .sort((left, right) => left.sequence - right.sequence)
  }

  resolveBridgeResult(sessionId: string, commandId: string, result: BrowserActionResult): void {
    const runtime = this.require(sessionId).runtime
    if (!runtime.resolveBridgeResult) throw new BrowserHostError('BRIDGE_NOT_AVAILABLE', 'Session does not accept bridge results', 409)
    runtime.resolveBridgeResult(commandId, result)
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.closePromise) return session.closePromise
    const closePromise = session.reuseKey
      ? this.withResourceLock(session.reuseKey, () => this.closeManaged(sessionId, session))
      : this.closeManaged(sessionId, session)
    const trackedPromise = closePromise.catch((error) => {
      // Keep a failed close in the manager so the caller/reaper can retry the
      // actual runtime cleanup. Deleting it here would make the API look
      // complete while Chromium/SSH resources could still be alive.
      if (this.sessions.get(sessionId) === session) {
        session.closePromise = undefined
        session.cleanupTimer = setTimeout(() => { void this.close(sessionId).catch(() => undefined) }, this.options.sessionTtlMs)
        session.cleanupTimer.unref()
      }
      throw error
    })
    session.closePromise = trackedPromise
    return trackedPromise
  }

  private async closeManaged(sessionId: string, session: ManagedSession): Promise<void> {
    clearTimeout(session.cleanupTimer)
    session.state = { ...session.state, status: 'closing', updatedAt: nowIso(this.now) }
    this.emit(sessionId, { type: 'session.state', state: session.state })
    try {
      await session.runtime.close()
      session.state = { ...session.state, status: 'closed', updatedAt: nowIso(this.now) }
      this.emit(sessionId, { type: 'session.state', state: session.state })
      session.emitter.removeAllListeners()
      this.sessions.delete(sessionId)
    } catch (error) {
      const failure = toBrowserHostError(error)
      const errorPayload = { code: failure.code, message: failure.message, recoverable: failure.recoverable }
      session.state = { ...session.state, status: 'failed', updatedAt: nowIso(this.now), error: errorPayload }
      this.emit(sessionId, { type: 'runtime.error', error: errorPayload })
      throw failure
    }
  }

  private async withResourceLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.resourceLocks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolveRelease) => { release = resolveRelease })
    const queued = previous.then(() => current)
    this.resourceLocks.set(key, queued)
    try {
      await previous
      return await operation()
    } finally {
      release()
      if (this.resourceLocks.get(key) === queued) this.resourceLocks.delete(key)
    }
  }

  async closeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.sessions.keys()].map((id) => this.close(id)))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) {
      throw new AggregateError(failures.map((failure) => failure.reason), 'One or more Browser sessions failed to close')
    }
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
    if (event.type === 'page.screencast') session.latestScreencasts.set(event.pageId, envelope)
    if (event.type === 'page.closed') session.latestScreencasts.delete(event.pageId)
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
