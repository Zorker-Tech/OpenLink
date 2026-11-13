import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
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
  providerModelConfig?: ProviderModelConfig
  browserHostUrl?: string
  browserSessionId?: string
  browserControlToken?: string
  browserExtensionPath?: string
  desktopExtensionPath?: string
  projectMemoryExtensionPath?: string
  runtimePolicy?: string
}

interface ProviderModelConfig {
  id: string
  name: string
  api?: string
  reasoning: boolean
  input: Array<'text' | 'image'>
  contextWindow: number
  maxTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

/**
 * Custom endpoints have no built-in Pi catalog entry. The Agent Host passes
 * the selected model's metadata so the worker can register exactly that model
 * in models.json; otherwise the CLI cannot resolve `custom/<model>`.
 */
function providerModelConfig(): ProviderModelConfig | undefined {
  const raw = process.env.OPENLINK_PROVIDER_MODEL_CONFIG?.trim()
  if (!raw || raw.length > 16_000) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const input = parsed as Record<string, unknown>
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!id || id.length > 256) return undefined
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 256) : id
  const api = typeof input.api === 'string' && /^[a-z0-9-]{1,64}$/.test(input.api) ? input.api : undefined
  const inputTypes = Array.isArray(input.input)
    ? input.input.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image')
    : []
  const positiveInteger = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
  const nonNegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  const cost = input.cost && typeof input.cost === 'object' ? input.cost as Record<string, unknown> : {}
  return {
    id,
    name,
    ...(api !== undefined ? { api } : {}),
    reasoning: input.reasoning === true,
    input: inputTypes.length > 0 ? inputTypes : ['text'],
    contextWindow: positiveInteger(input.contextWindow, 128_000),
    maxTokens: positiveInteger(input.maxTokens, 8_192),
    cost: {
      input: nonNegative(cost.input),
      output: nonNegative(cost.output),
      cacheRead: nonNegative(cost.cacheRead),
      cacheWrite: nonNegative(cost.cacheWrite),
    },
  }
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

function modelConfigFromModel(model: string | undefined, providerId: string | undefined): ProviderModelConfig | undefined {
  if (!model || !providerId) return undefined
  const prefix = `${providerId}/`
  const id = model.startsWith(prefix) ? model.slice(prefix.length) : model
  if (!id) return undefined
  return {
    id,
    name: id,
    api: 'openai-completions',
    reasoning: false,
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

function loadConfig(): Config {
  const port = Number(process.env.OPENLINK_AGENT_RPC_PORT || 43131)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('OPENLINK_AGENT_RPC_PORT is invalid')
  const model = process.env.OPENLINK_AGENT_MODEL || process.env.GEMINI_MODEL
  const providerId = process.env.OPENLINK_PROVIDER_ID || (process.env.GEMINI_API_KEY ? 'google' : undefined)
  const providerBaseUrl = process.env.OPENLINK_PROVIDER_BASE_URL || process.env.GOOGLE_GEMINI_BASE_URL
  return {
    host: process.env.OPENLINK_AGENT_RPC_HOST || '0.0.0.0',
    port,
    token: required('OPENLINK_AGENT_RPC_TOKEN'),
    workspaceRoot: resolve(process.env.OPENLINK_AGENT_WORKSPACE_ROOT || '/workspace'),
    sessionRoot: resolve(process.env.OPENLINK_AGENT_SESSION_ROOT || '/openlink/session'),
    sessionId: required('OPENLINK_AGENT_SESSION_ID'),
    sessionFile: process.env.OPENLINK_AGENT_SESSION_FILE ? resolve(process.env.OPENLINK_AGENT_SESSION_FILE) : undefined,
    model,
    providerId,
    providerBaseUrl,
    providerModelConfig: providerModelConfig() ?? modelConfigFromModel(model, providerId),
    browserHostUrl: process.env.OPENLINK_BROWSER_HOST_URL,
    browserSessionId: process.env.OPENLINK_BROWSER_SESSION_ID,
    browserControlToken: process.env.OPENLINK_BROWSER_CONTROL_TOKEN,
    browserExtensionPath: process.env.OPENLINK_BROWSER_EXTENSION_PATH,
    desktopExtensionPath: process.env.OPENLINK_DESKTOP_EXTENSION_PATH,
    projectMemoryExtensionPath: process.env.OPENLINK_PROJECT_MEMORY_EXTENSION_PATH,
    runtimePolicy: process.env.OPENLINK_AGENT_RUNTIME_POLICY?.trim() || undefined,
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
      const modelConfig = this.config.providerModelConfig
      await writeFile(resolve(configDir, 'models.json'), JSON.stringify({
        providers: {
          [this.config.providerId]: {
            baseUrl: this.config.providerBaseUrl,
            ...(process.env.OPENLINK_PROVIDER_API_KEY ? { apiKey: '$OPENLINK_PROVIDER_API_KEY' } : {}),
            ...(modelConfig ? {
              models: [{
                id: modelConfig.id,
                name: modelConfig.name,
                ...(modelConfig.api !== undefined ? { api: modelConfig.api } : {}),
                reasoning: modelConfig.reasoning,
                input: modelConfig.input,
                cost: modelConfig.cost,
                contextWindow: modelConfig.contextWindow,
                maxTokens: modelConfig.maxTokens,
              }],
            } : {}),
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
    if (this.config.desktopExtensionPath) args.push('--extension', this.config.desktopExtensionPath)
    if (this.config.projectMemoryExtensionPath) args.push('--extension', this.config.projectMemoryExtensionPath)
    if (this.config.runtimePolicy) args.push('--append-system-prompt', this.config.runtimePolicy)
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
let desktopProcess: ChildProcess | undefined

function startDesktopProcess(): void {
  if (desktopProcess && desktopProcess.exitCode === null && !desktopProcess.killed) return
  const child = spawn('bash', ['/opt/openlink/desktop/start.sh'], {
    cwd: config.workspaceRoot,
    env: process.env,
    stdio: 'ignore',
  })
  desktopProcess = child
  child.once('error', (error) => {
    if (desktopProcess === child) desktopProcess = undefined
    console.error(`OpenLink desktop process failed to start: ${error.message}`)
  })
  child.once('exit', (code, signal) => {
    if (desktopProcess === child) desktopProcess = undefined
    if (code !== 0 && code !== null) console.error(`OpenLink desktop process exited with code ${code}`)
    if (signal) console.error(`OpenLink desktop process exited from signal ${signal}`)
  })
}

type DesktopState = 'stopped' | 'installing' | 'booting' | 'running' | 'suspended' | 'failed'

const desktopMode = process.env.OPENLINK_DESKTOP_MODE === 'ubuntu-iso' ? 'ubuntu-iso' : 'ubuntu-container'
const desktopQmpSocket = '/tmp/openlink-ubuntu-vm-qmp.sock'
const desktopControlScript = '/opt/openlink/desktop/qmp-control.py'
const desktopInstalledMarker = resolve(config.sessionRoot, 'ubuntu-desktop', 'installed')
const execFileAsync = promisify(execFile)

function desktopProcessRunning(): boolean {
  return Boolean(desktopProcess && desktopProcess.exitCode === null && !desktopProcess.killed)
}

async function desktopMarkerExists(): Promise<boolean> {
  try { await access(desktopInstalledMarker); return true } catch { return false }
}

async function runDesktopQmp(command: 'status' | 'suspend' | 'resume'): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync('python3', [desktopControlScript, desktopQmpSocket, command], { timeout: 10_000 })
  const line = stdout.trim().split('\n').pop() || ''
  if (!line) throw new Error(`QMP ${command} returned no output`)
  const result = JSON.parse(line) as Record<string, unknown>
  if (result.ok === false) throw new Error(typeof result.error === 'string' ? result.error : `QMP ${command} failed`)
  return result
}

async function desktopRuntimeState(): Promise<{ state: DesktopState; suspended: boolean }> {
  if (!desktopProcessRunning()) return { state: 'stopped', suspended: false }
  if (desktopMode !== 'ubuntu-iso') return { state: 'running', suspended: false }
  if (!(await desktopMarkerExists())) return { state: 'installing', suspended: false }
  try {
    const result = await runDesktopQmp('status')
    // The installer and the installed desktop share the QMP socket. Only the
    // final VM may be paused; an installer in its late-command/reboot phase
    // still has the installed marker.
    if (result.name !== 'openlink-ubuntu-desktop') return { state: 'booting', suspended: false }
    if (result.status === 'paused') return { state: 'suspended', suspended: true }
    if (result.status === 'running') return { state: 'running', suspended: false }
    return { state: 'booting', suspended: false }
  } catch {
    return { state: 'booting', suspended: false }
  }
}
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
    if (request.method === 'POST' && url.pathname === '/desktop/start') {
      startDesktopProcess()
      response.writeHead(202, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ok: true }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/desktop/status') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(await desktopRuntimeState()))
      return
    }
    if (request.method === 'POST' && url.pathname === '/desktop/suspend') {
      const current = await desktopRuntimeState()
      if (current.state === 'suspended') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify({ suspended: true, state: current.state }))
        return
      }
      if (desktopMode !== 'ubuntu-iso' || current.state !== 'running') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify({ suspended: false, state: current.state }))
        return
      }
      await runDesktopQmp('suspend')
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify({ suspended: true, state: 'suspended' }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/desktop/resume') {
      const current = await desktopRuntimeState()
      if (current.state !== 'suspended') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify({ suspended: false, state: current.state }))
        return
      }
      await runDesktopQmp('resume')
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify({ suspended: false, state: 'running' }))
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
