import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import {
  BROWSER_PROTOCOL_VERSION,
  isBrowserActionEnvelope,
  isBrowserSocketClientMessage,
  isBrowserViewport,
  type BrowserActionEnvelope,
  type BrowserSocketServerMessage,
} from '@openlink/browser-protocol'
import { assertServiceAuthorization, BrowserTokenService } from './auth.js'
import type { BrowserHostConfig } from './config.js'
import { ChromiumRuntime } from './chromium-runtime.js'
import { BrowserHostError, toBrowserHostError } from './errors.js'
import { NativePreviewProxy } from './preview-proxy.js'
import { NativePreviewRuntime, type NativePreviewRuntimeOptions } from './preview-runtime.js'
import { BrowserSessionManager } from './session-manager.js'

interface CreateSessionBody {
  ownerId: string
  workspaceId: string
  projectId: string
  profileKey?: string
  surface: 'native-preview' | 'chromium-stream'
  viewport?: unknown
  preview?: Omit<NativePreviewRuntimeOptions, 'publicBaseUrl' | 'parentOrigins'>
  chromium?: {
    initialUrl?: string
    initialRequestHeaders?: Record<string, string>
    headless?: boolean
    preserveProfile?: boolean
    networkPolicy?: {
      allowedDomains?: string[]
      deniedDomains?: string[]
      allowLoopback?: boolean
      allowPrivateNetworks?: boolean
    }
  }
}

const MAX_JSON_BYTES = 1024 * 1024
const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body))
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(payload)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_JSON_BYTES) throw new BrowserHostError('BODY_TOO_LARGE', 'JSON body exceeds 1 MiB', 413)
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new BrowserHostError('INVALID_JSON', 'Request body is not valid JSON', 400)
  }
}

function isCreateSessionBody(value: unknown): value is CreateSessionBody {
  if (typeof value !== 'object' || value === null) return false
  const body = value as Partial<CreateSessionBody>
  return typeof body.ownerId === 'string' && body.ownerId.length > 0 && body.ownerId.length <= 256
    && typeof body.workspaceId === 'string' && body.workspaceId.length > 0 && body.workspaceId.length <= 256
    && typeof body.projectId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.projectId)
    && (body.profileKey === undefined || /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body.profileKey))
    && (body.surface === 'native-preview' || body.surface === 'chromium-stream')
}

function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  return !!origin && allowed.includes(origin)
}

export class BrowserHostServer {
  readonly manager: BrowserSessionManager
  readonly tokens: BrowserTokenService
  private readonly previews = new Map<string, NativePreviewRuntime>()
  private readonly previewProxy: NativePreviewProxy
  private readonly webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_JSON_BYTES })
  private readonly server: Server

  constructor(readonly config: BrowserHostConfig) {
    this.manager = new BrowserSessionManager({
      maxSessions: config.maxSessions,
      sessionTtlMs: config.sessionTtlMs,
      controlLeaseTtlMs: config.controlLeaseTtlMs,
    })
    this.tokens = new BrowserTokenService(config.tokenSecret)
    this.previewProxy = new NativePreviewProxy(this.tokens, config.publicBaseUrl, (sessionId) => {
      try {
        this.manager.get(sessionId)
        return this.previews.get(sessionId)
      } catch {
        return undefined
      }
    })
    this.server = createServer((request, response) => void this.handleRequest(request, response))
    this.server.on('upgrade', (request, socket, head) => void this.handleUpgrade(request, socket, head))
    this.server.on('clientError', (_error, socket) => socket.destroy())
    this.server.on('connection', (socket) => socket.on('error', () => undefined))
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off('error', reject)
        resolve()
      })
    })
  }

  async close(): Promise<void> {
    for (const client of this.webSockets.clients) client.terminate()
    let failure: unknown
    try {
      await this.manager.closeAll()
    } catch (error) {
      failure = error
    } finally {
      // A runtime may reject during close, but its preview tunnel and HTTP
      // listener still must be dismantled before the process exits.
      this.previews.clear()
      this.previewProxy.close()
      this.server.closeIdleConnections()
      this.server.closeAllConnections()
      await new Promise<void>((resolve) => this.server.close(() => resolve()))
    }
    if (failure) throw failure
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url || '/', this.config.publicBaseUrl)
      const origin = request.headers.origin
      if (originAllowed(origin, this.config.allowedParentOrigins)) {
        response.setHeader('Access-Control-Allow-Origin', origin!)
        response.setHeader('Access-Control-Allow-Credentials', 'true')
        response.setHeader('Vary', 'Origin')
      }
      if (request.method === 'OPTIONS') {
        if (!originAllowed(origin, this.config.allowedParentOrigins)) throw new BrowserHostError('ORIGIN_DENIED', 'Request origin is not allowed', 403)
        response.writeHead(204, {
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Max-Age': '600',
        })
        response.end()
        return
      }

      if (request.method === 'GET' && url.pathname === '/healthz') {
        json(response, 200, { ok: true, sessions: this.manager.list().length })
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/browser/inspector-bridge.js') {
        this.previewProxy.serveBridge(response)
        return
      }

      const previewMatch = /^\/v1\/browser\/sessions\/([^/]+)\/preview(?:\/|$)/.exec(url.pathname)
      if (previewMatch) {
        await this.previewProxy.handleHttp(request, response, decodeURIComponent(previewMatch[1]))
        return
      }

      const actionMatch = /^\/v1\/browser\/sessions\/([^/]+)\/actions$/.exec(url.pathname)
      if (actionMatch && request.method === 'POST') {
        const sessionId = decodeURIComponent(actionMatch[1])
        const allowedActors = this.assertSessionControlAuthorization(request.headers.authorization, sessionId)
        const body = await readJson(request)
        if (!isBrowserActionEnvelope(body) || body.sessionId !== sessionId) {
          throw new BrowserHostError('INVALID_ACTION', 'Browser action envelope is invalid', 400)
        }
        if (allowedActors && !allowedActors.includes(body.actor)) throw new BrowserHostError('ACTOR_DENIED', `Capability cannot act as ${body.actor}`, 403)
        json(response, 200, { result: await this.manager.perform(body) })
        return
      }

      const capabilityMatch = /^\/v1\/browser\/sessions\/([^/]+)\/capability$/.exec(url.pathname)
      if (capabilityMatch && request.method === 'POST') {
        const sessionId = decodeURIComponent(capabilityMatch[1])
        const header = request.headers.authorization
        if (!header?.startsWith('Bearer ')) throw new BrowserHostError('AUTH_REQUIRED', 'Browser capability authorization is required', 401)
        const claims = this.tokens.verify(header.slice('Bearer '.length), 'control', sessionId)
        if (!claims.actors.includes('agent')) throw new BrowserHostError('ACTOR_DENIED', 'Only the agent capability can refresh itself', 403)
        this.manager.get(sessionId, claims.ownerId)
        this.manager.touch(sessionId)
        const state = this.manager.get(sessionId, claims.ownerId)
        const ttlMs = Math.max(60_000, Date.parse(state.expiresAt) - Date.now())
        const controlToken = this.tokens.issue({ sessionId, ownerId: claims.ownerId, scopes: ['control'], actors: ['agent'], ttlMs })
        json(response, 200, { controlToken, expiresAt: state.expiresAt })
        return
      }

      assertServiceAuthorization(request.headers.authorization, this.config.apiToken)
      if (request.method === 'POST' && url.pathname === '/v1/browser/sessions') {
        await this.createSession(await readJson(request), response)
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/browser/sessions') {
        const ownerId = url.searchParams.get('ownerId') || undefined
        json(response, 200, { sessions: this.manager.list(ownerId) })
        return
      }
      const sessionMatch = /^\/v1\/browser\/sessions\/([^/]+)$/.exec(url.pathname)
      if (sessionMatch && request.method === 'GET') {
        json(response, 200, { session: this.manager.get(decodeURIComponent(sessionMatch[1])) })
        return
      }
      if (sessionMatch && request.method === 'DELETE') {
        const id = decodeURIComponent(sessionMatch[1])
        let closed = false
        try {
          await this.manager.close(id)
          closed = true
        } finally {
          // Native preview creates its tunnel before the runtime starts. A
          // close failure keeps the manager entry for retry, so retain its
          // preview mapping until the runtime has actually closed.
          if (closed) this.previews.delete(id)
        }
        response.writeHead(204)
        response.end()
        return
      }
      throw new BrowserHostError('NOT_FOUND', 'Route not found', 404)
    } catch (error) {
      const failure = toBrowserHostError(error)
      if (!response.headersSent) json(response, failure.status, { error: { code: failure.code, message: failure.message, recoverable: failure.recoverable } })
      else response.destroy(failure)
    }
  }

  private async createSession(raw: unknown, response: ServerResponse): Promise<void> {
    if (!isCreateSessionBody(raw)) throw new BrowserHostError('INVALID_SESSION', 'Session request is invalid', 400)
    const viewport = raw.viewport === undefined ? undefined : isBrowserViewport(raw.viewport) ? raw.viewport : undefined
    if (raw.viewport !== undefined && !viewport) throw new BrowserHostError('INVALID_VIEWPORT', 'Viewport is invalid', 400)

    let previewRuntime: NativePreviewRuntime | undefined
    let state: Awaited<ReturnType<BrowserSessionManager['create']>>
    try {
      state = await this.manager.create({
        ownerId: raw.ownerId,
        workspaceId: raw.workspaceId,
        projectId: raw.projectId,
        surface: raw.surface,
        viewport,
        // Chromium's persistent profile is derived from this same identity.
        // Keep lifecycle operations serialized at the Browser Host boundary
        // so UI reconnects cannot concurrently launch that profile.
        reuseKey: raw.surface === 'chromium-stream' && raw.profileKey
          ? `${raw.ownerId}\u0000${raw.workspaceId}\u0000${raw.projectId}\u0000${raw.profileKey}`
          : undefined,
        runtimeFactory: (context) => {
          if (raw.surface === 'native-preview') {
            if (!raw.preview) throw new BrowserHostError('INVALID_PREVIEW_TARGET', 'Preview configuration is required', 400)
            previewRuntime = new NativePreviewRuntime(context, {
              ...raw.preview,
              publicBaseUrl: this.config.publicBaseUrl,
              parentOrigins: this.config.allowedParentOrigins,
            })
            this.previews.set(context.sessionId, previewRuntime)
            return previewRuntime
          }
          if (!this.config.chromeExecutable) throw new BrowserHostError('CHROMIUM_NOT_CONFIGURED', 'OPENLINK_CHROME_EXECUTABLE is required for Chromium sessions', 503)
          return new ChromiumRuntime(context, {
            executablePath: this.config.chromeExecutable,
            storageRoot: this.config.storageRoot,
            profileKey: raw.profileKey,
            initialUrl: raw.chromium?.initialUrl,
            initialRequestHeaders: raw.chromium?.initialRequestHeaders,
            headless: raw.chromium?.headless ?? true,
            preserveProfile: raw.chromium?.preserveProfile,
            networkPolicy: {
              allowedDomains: raw.chromium?.networkPolicy?.allowedDomains ?? [],
              deniedDomains: raw.chromium?.networkPolicy?.deniedDomains ?? [],
              allowLoopback: raw.chromium?.networkPolicy?.allowLoopback ?? false,
              allowPrivateNetworks: raw.chromium?.networkPolicy?.allowPrivateNetworks ?? false,
            },
          })
        },
      })
    } catch (error) {
      // NativePreviewRuntime is registered before BrowserSessionManager starts
      // it. If startup fails, the manager removes its session but this map
      // would otherwise retain the failed runtime and its tunnel forever.
      if (previewRuntime) this.previews.delete(previewRuntime.sessionId)
      throw error
    }

    const capabilityTtl = Math.max(60_000, Date.parse(state.expiresAt) - Date.now())
    const eventsToken = this.tokens.issue({ sessionId: state.id, ownerId: state.ownerId, scopes: ['events', 'control'], actors: ['human'], ttlMs: capabilityTtl })
    const agentControlToken = this.tokens.issue({ sessionId: state.id, ownerId: state.ownerId, scopes: ['control'], actors: ['agent'], ttlMs: capabilityTtl })
    const previewToken = previewRuntime
      ? this.tokens.issue({ sessionId: state.id, ownerId: state.ownerId, scopes: ['preview'], ttlMs: capabilityTtl })
      : undefined
    const previewUrl = previewRuntime && previewToken
      ? `${this.config.publicBaseUrl}${previewRuntime.publicPath}/__openlink_bootstrap?token=${encodeURIComponent(previewToken)}`
      : undefined
    json(response, 201, {
      version: BROWSER_PROTOCOL_VERSION,
      session: { ...state, previewUrl },
      connection: {
        eventsUrl: `${this.config.publicBaseUrl.replace(/^http/, 'ws')}/v1/browser/sessions/${encodeURIComponent(state.id)}/events?token=${encodeURIComponent(eventsToken)}`,
        previewUrl,
        bridgeNonce: previewRuntime?.bridgeNonce,
        controlToken: agentControlToken,
      },
    })
  }

  private assertSessionControlAuthorization(header: string | undefined, sessionId: string): Array<'human' | 'agent'> | null {
    if (!header?.startsWith('Bearer ')) throw new BrowserHostError('AUTH_REQUIRED', 'Browser control authorization is required', 401)
    const token = header.slice('Bearer '.length)
    if (token === this.config.apiToken) return null
    const claims = this.tokens.verify(token, 'control', sessionId)
    this.manager.get(sessionId, claims.ownerId)
    return claims.actors
  }

  private handleUpgrade(request: IncomingMessage, rawSocket: Duplex, head: Buffer): void {
    const socket = rawSocket as Socket
    try {
      const url = new URL(request.url || '/', this.config.publicBaseUrl)
      const eventsMatch = /^\/v1\/browser\/sessions\/([^/]+)\/events$/.exec(url.pathname)
      if (eventsMatch) {
        const sessionId = decodeURIComponent(eventsMatch[1])
        const token = url.searchParams.get('token')
        if (!token) throw new BrowserHostError('AUTH_REQUIRED', 'Events capability is required', 401)
        const claims = this.tokens.verify(token, 'events', sessionId)
        const state = this.manager.get(sessionId, claims.ownerId)
        const origin = request.headers.origin
        if (!originAllowed(origin, this.config.allowedParentOrigins)) throw new BrowserHostError('ORIGIN_DENIED', 'WebSocket origin is not allowed', 403)
        if (!claims.actors.includes('human')) throw new BrowserHostError('ACTOR_DENIED', 'Events capability cannot control the human surface', 403)
        this.webSockets.handleUpgrade(request, socket, head, (webSocket) => this.handleEventsSocket(webSocket, sessionId, state.ownerId, claims.actors))
        return
      }
      const previewMatch = /^\/v1\/browser\/sessions\/([^/]+)\/preview(?:\/|$)/.exec(url.pathname)
      if (previewMatch) {
        this.previewProxy.handleUpgrade(request, socket, head, decodeURIComponent(previewMatch[1]))
        return
      }
      socket.destroy()
    } catch (error) {
      const failure = toBrowserHostError(error)
      socket.write(`HTTP/1.1 ${failure.status} ${failure.message.replace(/[\r\n]/g, ' ')}\r\nConnection: close\r\n\r\n`)
      socket.destroy()
    }
  }

  private handleEventsSocket(socket: WebSocket, sessionId: string, ownerId: string, allowedActors: Array<'human' | 'agent'>): void {
    let rateWindowStartedAt = Date.now()
    let rateWindowMessages = 0
    const send = (message: BrowserSocketServerMessage) => {
      if (socket.readyState !== WebSocket.OPEN) return
      if (socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES && message.type === 'event' && message.payload.event.type === 'page.screencast') return
      socket.send(JSON.stringify(message))
    }
    const state = this.manager.get(sessionId, ownerId)
    const replay = this.manager.replay(sessionId)
    send({ type: 'snapshot', payload: state, sequence: replay.at(-1)?.sequence ?? 0 })
    // A Chromium screencast frame can be emitted while the browser session is
    // being created, before the UI has opened its WebSocket. Replay the latest
    // frame for every page explicitly; the state snapshot's sequence cursor
    // intentionally does not include these frame payloads.
    for (const event of this.manager.latestScreencasts(sessionId)) send({ type: 'event', payload: event })
    const unsubscribe = this.manager.subscribe(sessionId, (event) => send({ type: 'event', payload: event }), replay.at(-1)?.sequence ?? 0)
    socket.on('message', (data, isBinary) => {
      const now = Date.now()
      if (now - rateWindowStartedAt >= 1_000) {
        rateWindowStartedAt = now
        rateWindowMessages = 0
      }
      rateWindowMessages += 1
      if (rateWindowMessages > 300) {
        send({ type: 'error', error: { code: 'RATE_LIMITED', message: 'Browser input rate exceeded', recoverable: true } })
        return
      }
      const messageSize = Array.isArray(data) ? data.reduce((size, item) => size + item.length, 0) : data.byteLength
      if (isBinary || messageSize > MAX_JSON_BYTES) {
        send({ type: 'error', error: { code: 'INVALID_MESSAGE', message: 'Binary or oversized messages are not accepted', recoverable: false } })
        return
      }
      let message: unknown
      try { message = JSON.parse(data.toString()) as unknown } catch {
        send({ type: 'error', error: { code: 'INVALID_MESSAGE', message: 'Message is not valid JSON', recoverable: true } })
        return
      }
      if (!isBrowserSocketClientMessage(message)) {
        send({ type: 'error', error: { code: 'INVALID_MESSAGE', message: 'Message does not match Browser Protocol', recoverable: true } })
        return
      }
      if (message.type === 'ping') {
        try {
          this.manager.touch(sessionId)
          send({ type: 'pong', nonce: message.nonce })
        } catch {
          send({ type: 'error', error: { code: 'SESSION_NOT_FOUND', message: 'Browser session is no longer available', recoverable: true } })
          socket.close(1008, 'Session is no longer available')
        }
      } else if (message.type === 'subscribe') {
        try {
          for (const event of this.manager.replay(sessionId, message.afterSequence ?? 0)) send({ type: 'event', payload: event })
        } catch {
          send({ type: 'error', error: { code: 'SESSION_NOT_FOUND', message: 'Browser session is no longer available', recoverable: true } })
          socket.close(1008, 'Session is no longer available')
        }
      } else if (message.type === 'bridge.result') {
        if (message.result.sessionId !== sessionId) return
        try {
          this.manager.resolveBridgeResult(sessionId, message.commandId, message.result)
        } catch {
          send({ type: 'error', error: { code: 'SESSION_NOT_FOUND', message: 'Browser session is no longer available', recoverable: true } })
          socket.close(1008, 'Session is no longer available')
        }
      } else {
        if (message.payload.sessionId !== sessionId) return
        if (!allowedActors.includes(message.payload.actor)) {
          send({ type: 'error', error: { code: 'ACTOR_DENIED', message: `Capability cannot act as ${message.payload.actor}`, recoverable: false } })
          return
        }
        void this.manager.perform(message.payload).catch((error) => {
          const failure = toBrowserHostError(error)
          send({ type: 'error', error: { code: failure.code, message: failure.message, recoverable: failure.recoverable } })
        })
      }
    })
    socket.once('close', unsubscribe)
    socket.once('error', unsubscribe)
  }
}
