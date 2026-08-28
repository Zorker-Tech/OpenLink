import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  type ExtensionUIContext,
  type ExtensionUIDialogOptions,
  type AgentSession,
} from '@earendil-works/pi-coding-agent'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { EnvHttpProxyAgent, install, setGlobalDispatcher } from 'undici'
import { CodexAppServerRuntime } from './codex-runtime.js'

const execFileAsync = promisify(execFile)
const GIT_PATCH_LIMIT_PER_FILE = 24 * 1024
const GIT_PATCH_LIMIT_TOTAL = 96 * 1024
const FILE_PREVIEW_LIMIT = 192 * 1024

interface GitChangedFile {
  path: string
  additions?: number
  deletions?: number
  patch?: string
}

interface GitSnapshotFrame {
  type: 'openlink_git_snapshot'
  toolCallId: string
  baseCommit: string
  files: GitChangedFile[]
  additions: number
  deletions: number
  signature: string
}

interface CompletedMutableToolEvent extends Record<string, unknown> {
  type: 'tool_execution_end'
  toolCallId: string
  toolName: string
  isError: boolean
}

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
  browserHostUrl?: string
  browserSessionId?: string
  browserControlToken?: string
  browserExtensionPath?: string
  supabaseExtensionPath?: string
  agent: 'pi' | 'codex'
  codexBin: string
  codexHome: string
  accessMode: 'restricted' | 'ask' | 'open'
}

interface AgentExtensionUiResponse {
  id: string
  confirmed?: boolean
  value?: string
  cancelled?: true
}

interface PendingExtensionUiRequest {
  resolve(response: AgentExtensionUiResponse): void
  cancel(): void
}

function required(key: string): string {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`${key} is required`)
  return value
}

function config(): WorkerConfig {
  const port = Number(process.env.OPENLINK_AGENT_WORKER_PORT || 43130)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('OPENLINK_AGENT_WORKER_PORT is invalid')
  const accessMode = process.env.OPENLINK_AGENT_ACCESS_MODE === 'open' || process.env.OPENLINK_AGENT_ACCESS_MODE === 'ask'
    ? process.env.OPENLINK_AGENT_ACCESS_MODE as 'open' | 'ask'
    : 'restricted'
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
    browserHostUrl: process.env.OPENLINK_BROWSER_HOST_URL,
    browserSessionId: process.env.OPENLINK_BROWSER_SESSION_ID,
    browserControlToken: process.env.OPENLINK_BROWSER_CONTROL_TOKEN,
    browserExtensionPath: process.env.OPENLINK_BROWSER_EXTENSION_PATH,
    supabaseExtensionPath: process.env.OPENLINK_SUPABASE_EXTENSION_PATH,
    agent: process.env.OPENLINK_AGENT_KIND === 'codex' ? 'codex' : 'pi',
    codexBin: process.env.OPENLINK_CODEX_BIN || 'codex',
    codexHome: resolve(process.env.OPENLINK_CODEX_HOME || '/openlink/session/codex-home'),
    accessMode,
  }
}

function authorized(request: IncomingMessage, token: string): boolean {
  // OpenSandbox's server-proxy intentionally strips Authorization because it
  // is the control-plane credential. Use a dedicated capability header for
  // proxied Project VM traffic, while retaining Bearer for direct endpoints.
  const capability = request.headers['x-openlink-agent-worker-token']
  const authorization = request.headers.authorization
  const raw = Array.isArray(capability) ? capability[0] : capability
  const header = raw ? `Bearer ${raw}` : authorization
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

async function readExtensionUiResponse(request: IncomingMessage): Promise<AgentExtensionUiResponse> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 32 * 1024) throw new Error('Request body is too large')
    chunks.push(buffer)
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

function serializableEvent(event: unknown): unknown {
  if (!event || typeof event !== 'object') return event
  const value = event as Record<string, unknown>
  if (value.type !== 'message_update' || !value.assistantMessageEvent || typeof value.assistantMessageEvent !== 'object') return event
  const { partial: _partial, ...assistantMessageEvent } = value.assistantMessageEvent as Record<string, unknown>
  return { ...value, assistantMessageEvent }
}

function toolMayMutateWorkspace(event: unknown): event is CompletedMutableToolEvent {
  if (!event || typeof event !== 'object') return false
  const value = event as Record<string, unknown>
  if (value.type !== 'tool_execution_end' || value.isError === true || typeof value.toolCallId !== 'string') return false
  // Native edit/write operations are unambiguously mutating. Shell commands
  // can also update a project, so Git is the final authority: a read-only
  // command simply produces no new snapshot.
  return /(?:^|[-_ ])(edit|write|patch|file|bash|shell|terminal|command)(?:$|[-_ ])/i.test(String(value.toolName ?? ''))
}

function fileEditOperation(toolName: string): 'write' | 'edit' | undefined {
  const normalized = toolName.toLowerCase()
  if (/(^|[-_ ])write($|[-_ ])/.test(normalized)) return 'write'
  if (/(^|[-_ ])edit($|[-_ ])/.test(normalized) || /patch|apply_patch/.test(normalized)) return 'edit'
  return undefined
}

function filePathFromToolEvent(event: Record<string, unknown>): string {
  const args = event.args && typeof event.args === 'object' ? event.args as Record<string, unknown> : {}
  return typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : ''
}

async function filePreviewFrame(workspaceRoot: string, event: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const toolName = typeof event.toolName === 'string' ? event.toolName : ''
  const operation = fileEditOperation(toolName)
  const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : ''
  const path = filePathFromToolEvent(event)
  if (!operation || !toolCallId || !path) return null

  const absolutePath = resolve(workspaceRoot, path)
  const workspaceRelative = relative(workspaceRoot, absolutePath)
  if (workspaceRelative === '..' || workspaceRelative.startsWith('../') || workspaceRelative.includes('/../')) return null

  let content: string | undefined
  if (event.type === 'tool_execution_start' && operation === 'write') {
    const args = event.args && typeof event.args === 'object' ? event.args as Record<string, unknown> : {}
    content = typeof args.content === 'string' ? args.content : undefined
  }
  if (content === undefined) {
    try {
      const source = await readFile(absolutePath)
      if (source.includes(0)) return null
      content = source.subarray(0, FILE_PREVIEW_LIMIT).toString('utf8')
    } catch {
      return null
    }
  }
  return {
    type: 'openlink_file_preview',
    phase: event.type === 'tool_execution_end' ? 'completed' : 'editing',
    toolCallId,
    toolName,
    path,
    operation,
    content,
    truncated: content.length >= FILE_PREVIEW_LIMIT,
  }
}

async function runGit(workspaceRoot: string, args: string[], maxBuffer = GIT_PATCH_LIMIT_TOTAL + 16 * 1024): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspaceRoot, ...args], {
      cwd: workspaceRoot,
      maxBuffer,
      windowsHide: true,
    })
    return stdout
  } catch {
    return null
  }
}

function countLines(content: string): number {
  if (!content.length) return 0
  const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content
  return trimmed ? trimmed.split(/\r?\n/).length : 1
}

function untrackedPatch(path: string, content: string): string {
  const lines = content.split(/(?<=\n)/).map((line) => `+${line.endsWith('\n') ? line.slice(0, -1) : line}`)
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${countLines(content)} @@`,
    ...lines,
  ].join('\n')
}

async function gitSnapshot(workspaceRoot: string): Promise<GitSnapshotFrame | null> {
  const baseCommit = (await runGit(workspaceRoot, ['rev-parse', '--short=12', 'HEAD']))?.trim()
  if (!baseCommit) return null
  const status = await runGit(workspaceRoot, ['status', '--porcelain=v1', '-z'])
  if (status === null) return null

  const numstat = await runGit(workspaceRoot, ['diff', '--no-ext-diff', '--no-renames', '--numstat', '-z', 'HEAD', '--'])
  if (numstat === null) return null
  const stats = new Map<string, { additions?: number; deletions?: number }>()
  for (const entry of numstat.split('\0')) {
    if (!entry) continue
    const [rawAdditions, rawDeletions, path] = entry.split('\t')
    if (!path) continue
    stats.set(path, {
      ...(rawAdditions !== '-' ? { additions: Number(rawAdditions) || 0 } : {}),
      ...(rawDeletions !== '-' ? { deletions: Number(rawDeletions) || 0 } : {}),
    })
  }
  const untracked = (await runGit(workspaceRoot, ['ls-files', '--others', '--exclude-standard', '-z']))
  if (untracked === null) return null
  const untrackedPaths = untracked.split('\0').filter(Boolean)
  const paths = new Set([...stats.keys(), ...untrackedPaths])
  const files: GitChangedFile[] = []
  let remainingPatch = GIT_PATCH_LIMIT_TOTAL

  for (const path of [...paths].sort()) {
    const details = stats.get(path) ?? {}
    const absolutePath = resolve(workspaceRoot, path)
    // Git paths are expected to be workspace-relative. Preserve that boundary
    // even in the presence of a malicious filename from a mounted volume.
    if (relative(workspaceRoot, absolutePath).startsWith('..')) continue
    let patch = ''
    if (untrackedPaths.includes(path)) {
      try {
        const source = await readFile(absolutePath)
        // Avoid turning a binary asset into replacement characters in a text
        // diff. Git still reports the real file and its byte-level status.
        if (source.includes(0)) throw new Error('binary file')
        const content = source.toString('utf8')
        patch = untrackedPatch(path, content)
        details.additions = countLines(content)
        details.deletions = 0
      } catch {
        // Directories, binary files, and raced deletions are still included in
        // the Git file list, without inventing a text diff.
      }
    } else {
      patch = (await runGit(workspaceRoot, ['diff', '--no-ext-diff', '--no-renames', '--unified=3', 'HEAD', '--', path], GIT_PATCH_LIMIT_PER_FILE + 4 * 1024)) ?? ''
    }
    const boundedPatch = patch.slice(0, Math.max(0, Math.min(GIT_PATCH_LIMIT_PER_FILE, remainingPatch)))
    remainingPatch -= boundedPatch.length
    files.push({ path, ...details, ...(boundedPatch ? { patch: boundedPatch } : {}) })
  }

  const additions = files.reduce((total, file) => total + (file.additions ?? 0), 0)
  const deletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0)
  return {
    type: 'openlink_git_snapshot',
    toolCallId: '',
    baseCommit,
    files,
    additions,
    deletions,
    // This intentionally includes the actual diff, not only numstat: a
    // one-character replacement can have unchanged line counts.
    signature: JSON.stringify({ baseCommit, files }),
  }
}

class SdkAgentRuntime {
  private sessionPromise?: Promise<{ session: AgentSession; sessionManager: SessionManager }>
  private busy = false
  private activeAbort?: () => void
  private cancelRequested = false
  private activeResponse?: ServerResponse
  private activeSignal?: AbortSignal
  private readonly pendingUi = new Map<string, PendingExtensionUiRequest>()
  private gitSnapshotSignature?: string

  constructor(private readonly worker: WorkerConfig) {}

  async prompt(message: string, response: ServerResponse, signal: AbortSignal): Promise<void> {
    if (this.busy) throw new Error('Agent is already processing a prompt')
    this.busy = true
    this.activeResponse = response
    this.activeSignal = signal
    try {
      let context: { session: AgentSession; sessionManager: SessionManager }
      try {
        context = await this.session()
      } catch (error) {
        // A failed model/provider initialization must not permanently poison
        // this long-lived worker. The next prompt should be able to retry
        // after the caller fixes configuration instead of seeing a stale
        // "already processing" state or a cached rejected promise.
        this.sessionPromise = undefined
        throw error
      }
      const { session, sessionManager } = context
      const previousEntryCount = sessionManager.getEntries().length
      let eventQueue = Promise.resolve()
      const filePaths = new Map<string, string>()
      const unsubscribe = session.subscribe((event) => {
        // Preserve Pi's event order while the Git probe runs. In particular,
        // the UI must never receive a snapshot before the completed edit that
        // caused it.
        eventQueue = eventQueue.then(async () => {
          if (!response.writableEnded) response.write(`${JSON.stringify(serializableEvent(event))}\n`)
          if (event && typeof event === 'object' && (event.type === 'tool_execution_start' || event.type === 'tool_execution_end')) {
            const previewEvent = { ...(event as Record<string, unknown>) }
            if (event.type === 'tool_execution_start') {
              const path = filePathFromToolEvent(previewEvent)
              if (path && typeof event.toolCallId === 'string') filePaths.set(event.toolCallId, path)
            } else if (typeof event.toolCallId === 'string') {
              const path = filePaths.get(event.toolCallId)
              if (path) previewEvent.args = { path }
            }
            const preview = await filePreviewFrame(this.worker.workspaceRoot, previewEvent)
            if (preview && !response.writableEnded) response.write(`${JSON.stringify(preview)}\n`)
            if (event.type === 'tool_execution_end' && typeof event.toolCallId === 'string') filePaths.delete(event.toolCallId)
          }
          if (!toolMayMutateWorkspace(event)) return
          const snapshot = await gitSnapshot(this.worker.workspaceRoot)
          if (!snapshot || (!snapshot.files.length && !this.gitSnapshotSignature)) return
          if (snapshot.signature === this.gitSnapshotSignature) return
          this.gitSnapshotSignature = snapshot.signature
          snapshot.toolCallId = String(event.toolCallId)
          if (!response.writableEnded) response.write(`${JSON.stringify(snapshot)}\n`)
        }).catch((error) => {
          // Git reporting is observational. It must never take down the
          // agent stream or hide the original Pi tool result.
          console.error('OpenLink could not collect Git change data', error)
        })
      })
      const abort = () => { void session.abort() }
      this.activeAbort = abort
      if (this.cancelRequested) abort()
      signal.addEventListener('abort', abort, { once: true })
      let canceled = false
      try {
        await session.prompt(message, { source: 'rpc' })
      } catch (error) {
        canceled = signal.aborted || this.cancelRequested
        if (!canceled) throw error
      } finally {
        await eventQueue
        // Pi's abort path is allowed to settle without emitting
        // `agent_settled`. Send an explicit terminal frame so direct desktop
        // consumers (and the Web BFF drain path) never leave the turn looking
        // permanently Working after a canceled request.
        if ((canceled || signal.aborted || this.cancelRequested) && !response.writableEnded) {
          response.write(`${JSON.stringify({ type: 'extension_error', error: 'Agent request was canceled' })}\n`)
        }
        this.cancelRequested = false
        if (!response.writableEnded) {
          response.write(`${JSON.stringify({
            type: 'openlink_session_entries',
            header: sessionManager.getHeader(),
            entries: sessionManager.getEntries().slice(previousEntryCount),
          })}\n`)
        }
        signal.removeEventListener('abort', abort)
        unsubscribe()
        if (this.activeAbort === abort) this.activeAbort = undefined
        this.cancelPendingUi()
      }
    } finally {
      this.busy = false
      this.cancelRequested = false
      this.activeResponse = undefined
      this.activeSignal = undefined
      this.cancelPendingUi()
    }
  }

  cancel(): boolean {
    if (!this.busy) return false
    this.cancelRequested = true
    this.activeAbort?.()
    return true
  }

  async resolveExtensionUi(response: AgentExtensionUiResponse): Promise<void> {
    const pending = this.pendingUi.get(response.id)
    if (!pending || !this.activeResponse || this.activeResponse.writableEnded) {
      throw new Error('No active extension UI request matches this response')
    }
    this.writeFrame({ type: 'openlink_confirmation_resolved', ...response })
    pending.resolve(response)
  }

  private writeFrame(value: unknown): boolean {
    const response = this.activeResponse
    if (!response || response.writableEnded || response.destroyed) return false
    try {
      response.write(`${JSON.stringify(value)}\n`)
      return true
    } catch {
      return false
    }
  }

  private cancelPendingUi(): void {
    if (!this.pendingUi.size) return
    for (const [id, pending] of this.pendingUi) {
      this.writeFrame({ type: 'openlink_confirmation_resolved', id, cancelled: true })
      pending.cancel()
    }
    this.pendingUi.clear()
  }

  private requestUi<T>(
    request: Record<string, unknown>,
    options: ExtensionUIDialogOptions | undefined,
    fallback: T,
    parse: (response: AgentExtensionUiResponse) => T,
  ): Promise<T> {
    const response = this.activeResponse
    const signal = options?.signal ?? this.activeSignal
    if (!response || response.writableEnded || response.destroyed || signal?.aborted) return Promise.resolve(fallback)
    const id = randomUUID()
    return new Promise<T>((resolveValue) => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        if (timeout) clearTimeout(timeout)
        signal?.removeEventListener('abort', onAbort)
        this.pendingUi.delete(id)
      }
      const finish = (value: T) => {
        cleanup()
        resolveValue(value)
      }
      const onAbort = () => finish(fallback)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (options?.timeout && options.timeout > 0) timeout = setTimeout(() => finish(fallback), options.timeout)
      this.pendingUi.set(id, {
        resolve: (uiResponse) => finish(parse(uiResponse)),
        cancel: () => finish(fallback),
      })
      if (!this.writeFrame({ type: 'extension_ui_request', id, ...request })) finish(fallback)
    })
  }

  private createExtensionUIContext(): ExtensionUIContext {
    return {
      select: (title, options, opts) => this.requestUi(
        { method: 'select', title, options, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        opts,
        undefined,
        (response) => response.cancelled === true || typeof response.value !== 'string' ? undefined : response.value,
      ),
      confirm: (title, message, opts) => this.requestUi(
        { method: 'confirm', title, message, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        opts,
        false,
        (response) => response.cancelled === true ? false : response.confirmed === true,
      ),
      input: (title, placeholder, opts) => this.requestUi(
        { method: 'input', title, ...(placeholder !== undefined ? { placeholder } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        opts,
        undefined,
        (response) => response.cancelled === true || typeof response.value !== 'string' ? undefined : response.value,
      ),
      notify: (message, type) => { this.writeFrame({ type: 'extension_ui_request', id: randomUUID(), method: 'notify', message, notifyType: type }) },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => { this.writeFrame({ type: 'extension_ui_request', id: randomUUID(), method: 'setStatus', statusKey: key, statusText: text }) },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (key, content, options) => {
        if (content === undefined || Array.isArray(content)) this.writeFrame({ type: 'extension_ui_request', id: randomUUID(), method: 'setWidget', widgetKey: key, widgetLines: content, widgetPlacement: options?.placement })
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => { this.writeFrame({ type: 'extension_ui_request', id: randomUUID(), method: 'setTitle', title }) },
      custom: async <T>() => undefined as T,
      pasteToEditor: (text) => { this.writeFrame({ type: 'extension_ui_request', id: randomUUID(), method: 'set_editor_text', text }) },
      setEditorText: (text) => { this.writeFrame({ type: 'extension_ui_request', id: randomUUID(), method: 'set_editor_text', text }) },
      getEditorText: () => '',
      editor: (title, prefill) => this.requestUi({ method: 'editor', title, ...(prefill !== undefined ? { prefill } : {}) }, undefined, undefined, (response) => response.cancelled === true || typeof response.value !== 'string' ? undefined : response.value),
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      theme: undefined as never,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: 'Theme switching is not available in the headless worker' }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
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
      try {
        await modelRuntime.setRuntimeApiKey(this.worker.providerId, this.worker.providerApiKey)
      } catch (error) {
        // Pi commits runtime credentials before refreshing its local model
        // availability snapshot.  A refresh can fail in an isolated worker
        // (for example when the provider catalog is unavailable) even though
        // the credential is ready for the actual request.  Keep the runtime
        // usable and let the provider request report an actionable auth/model
        // error instead of failing the whole session before streaming starts.
        const message = error instanceof Error ? error.message : String(error)
        if (!message.startsWith('Credential setRuntimeApiKey committed')) throw error
        console.warn(`OpenLink provider availability refresh deferred for ${this.worker.providerId}: ${message}`)
      }
    }
    const selected = resolveCliModel({ cliModel: this.worker.model, modelRuntime })
    if (selected.error) throw new Error(selected.error)
    const sessionManager = this.worker.sessionFile
      ? SessionManager.open(this.worker.sessionFile, this.worker.sessionRoot, this.worker.workspaceRoot)
      : SessionManager.create(this.worker.workspaceRoot, this.worker.sessionRoot)
    const browserValues = [this.worker.browserHostUrl, this.worker.browserSessionId, this.worker.browserControlToken, this.worker.browserExtensionPath]
    if (browserValues.some(Boolean) && browserValues.some((value) => !value)) {
      throw new Error('OpenLink browser capability configuration is incomplete')
    }
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.worker.workspaceRoot,
      agentDir: this.worker.sessionRoot,
      noExtensions: true,
      additionalExtensionPaths: await availableExtensionPaths([
        this.worker.browserExtensionPath,
        this.worker.supabaseExtensionPath,
      ]),
    })
    await resourceLoader.reload()
    const { session } = await createAgentSession({
      cwd: this.worker.workspaceRoot,
      model: selected.model,
      thinkingLevel: selected.thinkingLevel,
      modelRuntime,
      sessionManager,
      resourceLoader,
    })
    await session.bindExtensions({ uiContext: this.createExtensionUIContext(), mode: 'rpc' })
    return { session, sessionManager }
  }
}

const worker = config()

/** Extension paths may reference files that only exist after an image
 * rebuild (for example the Supabase MCP bridge). Skip missing paths instead
 * of failing the whole worker session. */
async function availableExtensionPaths(paths: Array<string | undefined>): Promise<string[]> {
  const resolved: string[] = []
  for (const path of paths) {
    if (!path) continue
    try {
      await access(path)
      resolved.push(path)
    } catch {
      console.error(`OpenLink worker extension skipped (not found): ${path}`)
    }
  }
  return resolved
}
const runtime = worker.agent === 'codex'
  ? new CodexAppServerRuntime({
    workspaceRoot: worker.workspaceRoot,
    sessionRoot: worker.sessionRoot,
    codexHome: worker.codexHome,
    codexBin: worker.codexBin,
    model: worker.model,
    accessMode: worker.accessMode,
    apiKey: worker.providerApiKey,
    supabaseMcpUrl: process.env.OPENLINK_SUPABASE_MCP_URL,
    supabaseMcpToken: process.env.OPENLINK_SUPABASE_MCP_TOKEN,
  })
  : new SdkAgentRuntime(worker)
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    if (request.method === 'GET' && url.pathname === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: true, runtime: worker.agent === 'codex' ? 'codex-app-server' : 'pi-node-sdk' }))
      return
    }
    if (!authorized(request, worker.token)) {
      response.writeHead(403, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'AUTH_DENIED' }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/cancel') {
      const active = runtime.cancel()
      response.writeHead(202, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify({ ok: true, active }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/extension-ui-response') {
      const uiResponse = await readExtensionUiResponse(request)
      if (worker.agent === 'codex') {
        await (runtime as CodexAppServerRuntime).resolveApproval(uiResponse.id, uiResponse.confirmed === true)
      } else {
        await (runtime as SdkAgentRuntime).resolveExtensionUi(uiResponse)
      }
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
      'X-OpenLink-Agent-Worker': worker.agent === 'codex' ? 'codex-app-server' : 'pi-node-sdk',
    })
    response.flushHeaders?.()
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
