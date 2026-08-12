import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface Config {
  host: string
  port: number
  token: string
  workspaceRoot: string
  sessionRoot: string
  sessionId: string
  sessionFile?: string
  model?: string
  providerId?: string
  providerBaseUrl?: string
  browserHostUrl?: string
  browserSessionId?: string
  browserControlToken?: string
  browserExtensionPath?: string
}

interface AgentExtensionUiResponse {
  id: string
  confirmed?: boolean
  value?: string
  cancelled?: true
}

function required(key: string): string {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`${key} is required`)
  return value
}

function loadConfig(): Config {
  const port = Number(process.env.OPENLINK_AGENT_RPC_PORT || 43131)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('OPENLINK_AGENT_RPC_PORT is invalid')
  return {
    host: process.env.OPENLINK_AGENT_RPC_HOST || '0.0.0.0',
    port,
    token: required('OPENLINK_AGENT_RPC_TOKEN'),
    workspaceRoot: resolve(process.env.OPENLINK_AGENT_WORKSPACE_ROOT || '/workspace'),
    sessionRoot: resolve(process.env.OPENLINK_AGENT_SESSION_ROOT || '/openlink/session'),
    sessionId: required('OPENLINK_AGENT_SESSION_ID'),
    sessionFile: process.env.OPENLINK_AGENT_SESSION_FILE ? resolve(process.env.OPENLINK_AGENT_SESSION_FILE) : undefined,
    model: process.env.OPENLINK_AGENT_MODEL || process.env.GEMINI_MODEL,
    providerId: process.env.OPENLINK_PROVIDER_ID || (process.env.GEMINI_API_KEY ? 'google' : undefined),
    providerBaseUrl: process.env.OPENLINK_PROVIDER_BASE_URL || process.env.GOOGLE_GEMINI_BASE_URL,
    browserHostUrl: process.env.OPENLINK_BROWSER_HOST_URL,
    browserSessionId: process.env.OPENLINK_BROWSER_SESSION_ID,
    browserControlToken: process.env.OPENLINK_BROWSER_CONTROL_TOKEN,
    browserExtensionPath: process.env.OPENLINK_BROWSER_EXTENSION_PATH,
  }
}

function authorized(request: IncomingMessage, token: string): boolean {
  const scopedHeader = request.headers['x-openlink-agent-token']
  const supplied = typeof scopedHeader === 'string'
    ? scopedHeader
    : request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7)
      : ''
  if (!supplied) return false
  const actual = Buffer.from(supplied)
  const expected = Buffer.from(token)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

async function readMessage(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > 32 * 1024) throw new Error('Request body is too large')
    chunks.push(value)
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { message?: unknown }
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message || message.length > 10_000) throw new Error('message is invalid')
  return message
}

async function readExtensionUiResponse(request: IncomingMessage): Promise<AgentExtensionUiResponse> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > 32 * 1024) throw new Error('Request body is too large')
    chunks.push(value)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('Extension UI response is invalid JSON')
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Extension UI response is invalid')
  const body = parsed as Record<string, unknown>
  const id = typeof body.id === 'string' ? body.id : ''
  const confirmed = body.confirmed
  const value = body.value
  const cancelled = body.cancelled
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) throw new Error('Extension UI response id is invalid')
  if (confirmed !== undefined && typeof confirmed !== 'boolean') throw new Error('Extension UI confirmation is invalid')
  if (value !== undefined && (typeof value !== 'string' || value.length > 100_000)) throw new Error('Extension UI value is invalid')
  if (cancelled !== undefined && cancelled !== true) throw new Error('Extension UI cancellation is invalid')
  if (cancelled === true && (confirmed !== undefined || value !== undefined)) throw new Error('Extension UI response is ambiguous')
  if (confirmed === undefined && value === undefined && cancelled !== true) throw new Error('Extension UI response has no value')
  if (confirmed !== undefined && value !== undefined) throw new Error('Extension UI response is ambiguous')
  return {
    id,
    ...(confirmed !== undefined ? { confirmed } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(cancelled === true ? { cancelled: true } : {}),
  }
}

class RpcRuntime {
  private child?: ChildProcessWithoutNullStreams
  private stdoutBuffer = ''
  private stderr = ''
  private active?: { id: string; response: ServerResponse; previousEntryCount: number; finish: (error?: Error) => void; cancelTimer?: NodeJS.Timeout }
  private starting?: Promise<void>
  private promptInFlight = false
  private cancelRequested = false

  constructor(private readonly config: Config) {}

  async prompt(message: string, response: ServerResponse): Promise<void> {
    if (this.active || this.promptInFlight) throw new Error('Agent is already processing a prompt')
    this.promptInFlight = true
    try {
      await this.start()
      const id = crypto.randomUUID()
      const previousEntryCount = (await this.readNativeSession())?.entries.length ?? 0
      await new Promise<void>((resolvePrompt, rejectPrompt) => {
        const timeout = setTimeout(() => finish(new Error('Pi RPC prompt timed out')), 15 * 60_000)
        const finish = (error?: Error) => {
          clearTimeout(timeout)
          if (this.active?.cancelTimer) clearTimeout(this.active.cancelTimer)
          if (this.active?.id === id) this.active = undefined
          if (error) rejectPrompt(error)
          else resolvePrompt()
        }
        this.active = { id, response, previousEntryCount, finish }
        response.once('close', () => {
          if (!response.writableEnded && this.active?.id === id) {
            // Keep the Pi RPC process alive long enough to consume its abort
            // acknowledgement and flush the native JSONL file. Finishing the
            // request immediately here used to drop the final session delta
            // whenever an Agent Host/client disconnected mid-turn.
            void this.cancel()
          }
        })
        if (this.cancelRequested) {
          void this.cancel().catch(finish)
        } else {
          void this.write({ id, type: 'prompt', message }).catch(finish)
        }
      })
    } finally {
      this.promptInFlight = false
      this.cancelRequested = false
    }
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = undefined
    if (!child || child.exitCode !== null) return
    child.kill('SIGTERM')
    await Promise.race([
      new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
    ])
    if (child.exitCode === null) child.kill('SIGKILL')
  }

  async cancel(): Promise<boolean> {
    const active = this.active
    if (!active) {
      if (!this.promptInFlight) return false
      this.cancelRequested = true
      return true
    }
    this.cancelRequested = true
    try {
      await this.write({ type: 'abort' })
    } catch (error) {
      active.finish(error instanceof Error ? error : new Error(String(error)))
      return true
    }
    // Pi normally emits agent_settled after abort. Some provider/worker
    // failures settle without that frame, so force a bounded native-session
    // flush and terminal error rather than leaving the HTTP request busy.
    active.cancelTimer = setTimeout(() => {
      if (this.active?.id !== active.id) return
      void this.emitNativeSessionDelta(active)
        .then(() => active.finish(new Error('Request canceled')))
        .catch(active.finish)
    }, 5_000)
    active.cancelTimer.unref()
    return true
  }

  async resolveExtensionUi(response: AgentExtensionUiResponse): Promise<void> {
    const active = this.active
    if (!active || active.response.writableEnded || active.response.destroyed) {
      throw new Error('No active extension UI request is waiting for a response')
    }
    await this.write({ type: 'extension_ui_response', ...response })
    if (!active.response.writableEnded && !active.response.destroyed) {
      active.response.write(`${JSON.stringify({ type: 'openlink_confirmation_resolved', ...response })}\n`)
    }
  }

  private async start(): Promise<void> {
    if (this.child && this.child.exitCode === null) return
    this.starting ??= this.spawn().finally(() => { this.starting = undefined })
    await this.starting
  }

  private async spawn(): Promise<void> {
    const configDir = resolve(this.config.sessionRoot, 'config')
    const piSessions = resolve(this.config.sessionRoot, 'pi-sessions')
    await mkdir(configDir, { recursive: true, mode: 0o700 })
    await mkdir(piSessions, { recursive: true, mode: 0o700 })
    if (this.config.providerId && this.config.providerBaseUrl) {
      await writeFile(resolve(configDir, 'models.json'), JSON.stringify({
        providers: {
          [this.config.providerId]: {
            baseUrl: this.config.providerBaseUrl,
            ...(process.env.OPENLINK_PROVIDER_API_KEY ? { apiKey: '$OPENLINK_PROVIDER_API_KEY' } : {}),
          },
        },
      }), { mode: 0o600 })
    }
    const rpcEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'))
    const args = this.config.sessionFile
      ? [rpcEntry, '--session', this.config.sessionFile, '--session-dir', piSessions, '--no-approve']
      : [rpcEntry, '--session-dir', piSessions, '--session-id', this.config.sessionId, '--no-approve']
    if (this.config.model) args.push('--model', this.config.model)
    const browserValues = [this.config.browserHostUrl, this.config.browserSessionId, this.config.browserControlToken, this.config.browserExtensionPath]
    if (browserValues.some(Boolean) && browserValues.some((value) => !value)) {
      throw new Error('OpenLink browser capability configuration is incomplete')
    }
    if (this.config.browserExtensionPath) args.push('--extension', this.config.browserExtensionPath)
    const child = spawn(process.execPath, args, {
      cwd: this.config.workspaceRoot,
      env: { ...process.env, PI_CODING_AGENT_DIR: configDir },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout.on('data', (chunk: Buffer) => this.consumeStdout(chunk))
    child.stderr.on('data', (chunk: Buffer) => { this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-16_384) })
    child.once('error', (error) => this.fail(error))
    child.once('exit', (code) => this.fail(new Error(`Pi RPC exited with ${code ?? 'unknown'}${this.stderr ? `: ${this.stderr}` : ''}`)))
  }

  private consumeStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString('utf8')
    let newline = this.stdoutBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (line) this.consumeFrame(line)
      newline = this.stdoutBuffer.indexOf('\n')
    }
    if (Buffer.byteLength(this.stdoutBuffer) > 1024 * 1024) this.fail(new Error('Pi RPC frame is too large'))
  }

  private consumeFrame(line: string): void {
    let frame: Record<string, unknown>
    try { frame = JSON.parse(line) as Record<string, unknown> } catch { this.fail(new Error('Pi RPC emitted invalid JSONL')); return }
    const active = this.active
    if (!active) return
    active.response.write(`${line}\n`)
    if (frame.type === 'response' && frame.id === active.id && frame.success === false) {
      active.finish(new Error(typeof frame.error === 'string' ? frame.error : 'Pi rejected the prompt'))
    } else if (frame.type === 'agent_settled') {
      void this.emitNativeSessionDelta(active).then(() => active.finish()).catch(active.finish)
    }
  }

  private async resolveSessionFile(): Promise<string | undefined> {
    if (this.config.sessionFile) return this.config.sessionFile
    const directory = resolve(this.config.sessionRoot, 'pi-sessions')
    const suffix = `_${this.config.sessionId}.jsonl`
    const matches = (await readdir(directory).catch(() => [] as string[])).filter((name) => name.endsWith(suffix)).sort()
    return matches.length ? resolve(directory, matches.at(-1)!) : undefined
  }

  private async readNativeSession(): Promise<{ header: Record<string, unknown>; entries: Array<Record<string, unknown>> } | null> {
    const sessionFile = await this.resolveSessionFile()
    if (!sessionFile) return null
    const lines = (await readFile(sessionFile, 'utf8')).split('\n').filter(Boolean)
    if (!lines.length) return null
    const values = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    const header = values[0]
    if (header?.type !== 'session') throw new Error('Pi session header is invalid')
    return { header, entries: values.slice(1) }
  }

  private async emitNativeSessionDelta(active: NonNullable<RpcRuntime['active']>): Promise<void> {
    const snapshot = await this.readNativeSession()
    if (!snapshot || active.response.writableEnded) return
    active.response.write(`${JSON.stringify({
      type: 'openlink_session_entries',
      header: snapshot.header,
      entries: snapshot.entries.slice(active.previousEntryCount),
    })}\n`)
  }

  private write(value: unknown): Promise<void> {
    const child = this.child
    if (!child?.stdin.writable) return Promise.reject(new Error('Pi RPC stdin is unavailable'))
    return new Promise((resolveWrite, rejectWrite) => {
      child.stdin.write(`${JSON.stringify(value)}\n`, (error) => error ? rejectWrite(error) : resolveWrite())
    })
  }

  private fail(error: Error): void {
    this.active?.finish(error)
    this.active = undefined
  }
}

const config = loadConfig()
const runtime = new RpcRuntime(config)
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    if (request.method === 'GET' && url.pathname === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, runtime: 'pi-cli-rpc' }))
      return
    }
    if (!authorized(request, config.token)) {
      response.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'AUTH_DENIED' }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/cancel') {
      const active = await runtime.cancel()
      response.writeHead(202, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify({ ok: true, active }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/extension-ui-response') {
      const uiResponse = await readExtensionUiResponse(request)
      await runtime.resolveExtensionUi(uiResponse)
      response.writeHead(202, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify({ ok: true }))
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
      'X-OpenLink-Agent-Worker': 'pi-cli-rpc',
    })
    response.flushHeaders?.()
    await runtime.prompt(message, response)
    response.end()
  })().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    if (response.headersSent) {
      if (!response.writableEnded) response.end(`${JSON.stringify({ type: 'extension_error', error: message })}\n`)
    } else {
      response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: message }))
    }
  })
})

server.listen(config.port, config.host, () => process.stdout.write(`OpenLink Agent RPC Worker listening on http://${config.host}:${config.port}\n`))
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => { void runtime.stop().finally(() => process.exit(0)) }))
}
