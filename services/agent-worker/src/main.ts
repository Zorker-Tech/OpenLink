import {
  createAgentSession,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent'
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { EnvHttpProxyAgent, install, setGlobalDispatcher } from 'undici'

if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY) {
  setGlobalDispatcher(new EnvHttpProxyAgent({ allowH2: false }))
  install?.()
}

interface WorkerConfig {
  host: string
  port: number
  token: string
  workspaceRoot: string
  sessionRoot: string
  sessionFile?: string
  model?: string
  providerId?: string
  providerBaseUrl?: string
  providerApiKey?: string
}

function required(key: string): string {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`${key} is required`)
  return value
}

function config(): WorkerConfig {
  const port = Number(process.env.OPENLINK_AGENT_WORKER_PORT || 43130)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('OPENLINK_AGENT_WORKER_PORT is invalid')
  return {
    host: process.env.OPENLINK_AGENT_WORKER_HOST || '0.0.0.0',
    port,
    token: required('OPENLINK_AGENT_WORKER_TOKEN'),
    workspaceRoot: resolve(process.env.OPENLINK_AGENT_WORKSPACE_ROOT || '/workspace'),
    sessionRoot: resolve(process.env.OPENLINK_AGENT_SESSION_ROOT || '/openlink/session'),
    sessionFile: process.env.OPENLINK_AGENT_SESSION_FILE ? resolve(process.env.OPENLINK_AGENT_SESSION_FILE) : undefined,
    model: process.env.OPENLINK_AGENT_MODEL || process.env.GEMINI_MODEL,
    providerId: process.env.OPENLINK_PROVIDER_ID || (process.env.GEMINI_API_KEY ? 'google' : undefined),
    providerBaseUrl: process.env.OPENLINK_PROVIDER_BASE_URL || process.env.GOOGLE_GEMINI_BASE_URL,
    providerApiKey: process.env.OPENLINK_PROVIDER_API_KEY || process.env.GEMINI_API_KEY,
  }
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7))
  const expected = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

async function readMessage(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 32 * 1024) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { message?: unknown }
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message || message.length > 10_000) throw new Error('message is invalid')
  return message
}

function serializableEvent(event: unknown): unknown {
  if (!event || typeof event !== 'object') return event
  const value = event as Record<string, unknown>
  if (value.type !== 'message_update' || !value.assistantMessageEvent || typeof value.assistantMessageEvent !== 'object') return event
  const { partial: _partial, ...assistantMessageEvent } = value.assistantMessageEvent as Record<string, unknown>
  return { ...value, assistantMessageEvent }
}

class SdkAgentRuntime {
  private sessionPromise?: Promise<{ session: AgentSession; sessionManager: SessionManager }>
  private busy = false

  constructor(private readonly worker: WorkerConfig) {}

  async prompt(message: string, response: ServerResponse, signal: AbortSignal): Promise<void> {
    if (this.busy) throw new Error('Agent is already processing a prompt')
    this.busy = true
    const { session, sessionManager } = await this.session()
    const previousEntryCount = sessionManager.getEntries().length
    const unsubscribe = session.subscribe((event) => {
      if (!response.writableEnded) response.write(`${JSON.stringify(serializableEvent(event))}\n`)
    })
    const abort = () => { void session.abort() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      await session.prompt(message, { source: 'rpc' })
    } finally {
      if (!response.writableEnded) {
        response.write(`${JSON.stringify({
          type: 'openlink_session_entries',
          header: sessionManager.getHeader(),
          entries: sessionManager.getEntries().slice(previousEntryCount),
        })}\n`)
      }
      signal.removeEventListener('abort', abort)
      unsubscribe()
      this.busy = false
    }
  }

  private session(): Promise<{ session: AgentSession; sessionManager: SessionManager }> {
    this.sessionPromise ??= this.createSession()
    return this.sessionPromise
  }

  private async createSession(): Promise<{ session: AgentSession; sessionManager: SessionManager }> {
    await mkdir(this.worker.sessionRoot, { recursive: true, mode: 0o700 })
    const modelRuntime = await ModelRuntime.create({
      authPath: resolve(this.worker.sessionRoot, 'auth.json'),
      modelsPath: resolve(this.worker.sessionRoot, 'models.json'),
    })
    if (this.worker.providerId && this.worker.providerBaseUrl) {
      modelRuntime.registerProvider(this.worker.providerId, { baseUrl: this.worker.providerBaseUrl })
    }
    if (this.worker.providerId && this.worker.providerApiKey) {
      await modelRuntime.setRuntimeApiKey(this.worker.providerId, this.worker.providerApiKey)
    }
    const selected = resolveCliModel({ cliModel: this.worker.model, modelRuntime })
    if (selected.error) throw new Error(selected.error)
    const sessionManager = this.worker.sessionFile
      ? SessionManager.open(this.worker.sessionFile, this.worker.sessionRoot, this.worker.workspaceRoot)
      : SessionManager.create(this.worker.workspaceRoot, this.worker.sessionRoot)
    const { session } = await createAgentSession({
      cwd: this.worker.workspaceRoot,
      model: selected.model,
      thinkingLevel: selected.thinkingLevel,
      modelRuntime,
      sessionManager,
    })
    return { session, sessionManager }
  }
}

const worker = config()
const runtime = new SdkAgentRuntime(worker)
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    if (request.method === 'GET' && url.pathname === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: true, runtime: 'pi-node-sdk' }))
      return
    }
    if (!authorized(request, worker.token)) {
      response.writeHead(403, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'AUTH_DENIED' }))
      return
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/events') {
      response.writeHead(404).end()
      return
    }
    const message = await readMessage(request)
    response.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-OpenLink-Agent-Worker': 'pi-node-sdk',
    })
    const abortController = new AbortController()
    response.once('close', () => { if (!response.writableEnded) abortController.abort() })
    await runtime.prompt(message, response, abortController.signal)
    response.end()
  })().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    if (response.headersSent) {
      if (!response.writableEnded) response.end(`${JSON.stringify({ type: 'extension_error', error: message })}\n`)
    } else {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: message }))
    }
  })
})

server.listen(worker.port, worker.host, () => {
  process.stdout.write(`OpenLink Agent Worker listening on http://${worker.host}:${worker.port}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => process.exit(0)))
}
