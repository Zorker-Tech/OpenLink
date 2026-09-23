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
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { relative, resolve } from 'node:path'
import { EnvHttpProxyAgent, install, setGlobalDispatcher } from 'undici'
import { CodexAppServerRuntime, stageCodexPromptFiles } from './codex-runtime.js'
import { piPromptProtocolInput } from './prompt-protocol.js'
import { handleBrowserMcpRequest } from './browser-mcp.js'
import { createGitBaseline, collectGitSnapshot, type GitWorkingTreeBaseline } from './git-snapshot.js'

const FILE_PREVIEW_LIMIT = 192 * 1024

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
  browserCapabilityFile?: string
  supabaseExtensionPath?: string
  agent: 'pi' | 'codex'
  codexBin: string
  codexHome: string
  accessMode: 'restricted' | 'ask' | 'open'
  turnIdleTimeoutMs: number
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
  const configuredTurnIdleTimeout = Number(process.env.OPENLINK_AGENT_TURN_IDLE_TIMEOUT_MS || process.env.OPENLINK_CODEX_TURN_IDLE_TIMEOUT_MS)
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
    browserCapabilityFile: process.env.OPENLINK_BROWSER_CAPABILITY_FILE
      ? resolve(process.env.OPENLINK_BROWSER_CAPABILITY_FILE)
      : undefined,
    supabaseExtensionPath: process.env.OPENLINK_SUPABASE_EXTENSION_PATH,
    agent: process.env.OPENLINK_AGENT_KIND === 'codex' ? 'codex' : 'pi',
    codexBin: process.env.OPENLINK_CODEX_BIN || 'codex',
    codexHome: resolve(process.env.OPENLINK_CODEX_HOME || '/openlink/session/codex-home'),
    accessMode,
    turnIdleTimeoutMs: Number.isFinite(configuredTurnIdleTimeout) && configuredTurnIdleTimeout >= 1_000
      ? configuredTurnIdleTimeout
      : 10 * 60_000,
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

async function readRequestJson(request: IncomingMessage, maxBytes = 32 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function readMessage(request: IncomingMessage): Promise<string> {
  const body = await readRequestJson(request) as { message?: unknown }
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message || message.length > 10_000) throw new Error('message is invalid')
  return message
}

type WorkerPromptAttachment = {
  type: 'image'; mediaType: string; url: string; filename?: string
} | {
  type: 'text'; mediaType: 'text/plain'; text: string; filename?: string
} | {
  type: 'instruction'; name: string; text: string
} | {
  type: 'reference'; referenceType: 'file' | 'thread'; name: string; path: string
} | {
  type: 'file'; uploadId: string; batchId: string; mediaType: string; filename: string
  relativePath?: string; sizeBytes: number; sha256: string; contentBase64: string
}

async function readPrompt(request: IncomingMessage): Promise<{ message: string; attachments: WorkerPromptAttachment[] }> {
  const body = await readRequestJson(request, 16 * 1024 * 1024) as { message?: unknown; attachments?: unknown }
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (message.length > 10_000) throw new Error('message is invalid')
  if (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.length > 24)) throw new Error('attachments are invalid')
  let encodedImageBytes = 0
  let textBytes = 0
  let imageCount = 0
  let textCount = 0
  let instructionCount = 0
  let referenceCount = 0
  let fileCount = 0
  let encodedFileBytes = 0
  const attachments = (body.attachments ?? []).map((candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object') throw new Error('attachments are invalid')
    const item = candidate as Record<string, unknown>
    const mediaType = typeof item.mediaType === 'string' ? item.mediaType.toLowerCase() : ''
    const filename = typeof item.filename === 'string' ? item.filename.trim().slice(0, 240) : undefined
    if (item.type === 'file') {
      const uploadId = typeof item.uploadId === 'string' ? item.uploadId : ''
      const batchId = typeof item.batchId === 'string' ? item.batchId : ''
      const relativePath = typeof item.relativePath === 'string' ? item.relativePath : undefined
      const sizeBytes = typeof item.sizeBytes === 'number' ? item.sizeBytes : -1
      const sha256 = typeof item.sha256 === 'string' ? item.sha256.toLowerCase() : ''
      const contentBase64 = typeof item.contentBase64 === 'string' ? item.contentBase64 : ''
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      const safeFilename = Boolean(filename && filename !== '.' && filename !== '..' && !/[/\\\u0000-\u001f\u007f]/.test(filename))
      const safeRelativePath = relativePath === undefined || (relativePath.length <= 1024
        && !relativePath.startsWith('/') && !relativePath.includes('\\') && !relativePath.includes('//')
        && !/[\u0000-\u001f\u007f]/.test(relativePath)
        && relativePath.split('/').every((segment) => segment && segment !== '.' && segment !== '..'))
      fileCount += 1
      encodedFileBytes += contentBase64.length
      if (!uuid.test(uploadId) || !uuid.test(batchId) || !safeFilename || !safeRelativePath
        || !mediaType || mediaType.length > 160 || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > 2 * 1024 * 1024
        || !/^[a-f0-9]{64}$/.test(sha256) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)
        || fileCount > 16 || encodedFileBytes + encodedImageBytes > 12_000_000) throw new Error('attachments are invalid')
      const content = Buffer.from(contentBase64, 'base64')
      if (content.byteLength !== sizeBytes || createHash('sha256').update(content).digest('hex') !== sha256) throw new Error('attachments are invalid')
      return { type: 'file' as const, uploadId, batchId, mediaType, filename: filename!, ...(relativePath ? { relativePath } : {}), sizeBytes, sha256, contentBase64 }
    }
    if (item.type === 'reference') {
      const referenceType: 'file' | 'thread' | '' = item.referenceType === 'file' || item.referenceType === 'thread' ? item.referenceType : ''
      const name = typeof item.name === 'string' ? item.name.trim().slice(0, 160) : ''
      const path = typeof item.path === 'string' ? item.path : ''
      referenceCount += 1
      if (!referenceType || !name || referenceCount > 16 || path.length > 1024 || path.includes('\0')
        || (referenceType === 'thread' && !/^thread:\/\/[A-Za-z0-9_-]{1,64}$/.test(path))
        || (referenceType === 'file' && (!path || /^\w+:\/\//.test(path)))) throw new Error('attachments are invalid')
      return { type: 'reference' as const, referenceType, name, path }
    }
    if (item.type === 'text') {
      const text = typeof item.text === 'string' ? item.text : ''
      const bytes = Buffer.byteLength(text, 'utf8')
      textCount += 1
      textBytes += bytes
      if (mediaType !== 'text/plain' || !text || textCount > 4 || bytes > 256 * 1024 || textBytes > 512 * 1024) throw new Error('attachments are invalid')
      return { type: 'text' as const, mediaType: 'text/plain' as const, text, ...(filename ? { filename } : {}) }
    }
    if (item.type === 'instruction') {
      const name = typeof item.name === 'string' ? item.name.trim().slice(0, 160) : ''
      const text = typeof item.text === 'string' ? item.text : ''
      const bytes = Buffer.byteLength(text, 'utf8')
      instructionCount += 1
      if (!name || !text || instructionCount > 8 || bytes > 64 * 1024) throw new Error('attachments are invalid')
      return { type: 'instruction' as const, name, text }
    }
    const url = typeof item.url === 'string' ? item.url : ''
    imageCount += 1
    if (item.type !== 'image' || imageCount > 4 || !/^image\/(?:png|jpeg|webp|gif)$/.test(mediaType) || !url.startsWith(`data:${mediaType};base64,`) || url.length > 3_000_000) throw new Error('attachments are invalid')
    encodedImageBytes += url.length
    if (encodedImageBytes + encodedFileBytes > 12_000_000) throw new Error('attachments are invalid')
    return { type: 'image' as const, mediaType, url, ...(filename ? { filename } : {}) }
  })
  if (!message && !attachments.length) throw new Error('message is invalid')
  return { message, attachments }
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

async function readBrowserCapability(request: IncomingMessage): Promise<Record<string, string> | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 32 * 1024) throw new Error('Browser capability is too large')
    chunks.push(buffer)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { capability?: unknown }
  if (parsed.capability === null) return null
  if (!parsed.capability || typeof parsed.capability !== 'object') throw new Error('Browser capability is invalid')
  const value = parsed.capability as Record<string, unknown>
  if (typeof value.hostUrl !== 'string' || !/^https?:\/\//.test(value.hostUrl)
    || typeof value.sessionId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value.sessionId)
    || typeof value.controlToken !== 'string' || value.controlToken.length < 16) {
    throw new Error('Browser capability is invalid')
  }
  return { hostUrl: value.hostUrl, sessionId: value.sessionId, controlToken: value.controlToken }
}

async function writeBrowserCapability(capability: Record<string, string> | null): Promise<void> {
  if (!worker.browserCapabilityFile) throw new Error('Browser capability is not configured for this Agent')
  const temporary = `${worker.browserCapabilityFile}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(capability)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, worker.browserCapabilityFile)
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


class SdkAgentRuntime {
  private sessionPromise?: Promise<{ session: AgentSession; sessionManager: SessionManager }>
  private busy = false
  private activeAbort?: () => void
  private cancelRequested = false
  private activeResponse?: ServerResponse
  private activeSignal?: AbortSignal
  private readonly pendingUi = new Map<string, PendingExtensionUiRequest>()
  private gitSnapshotSignature?: string
  private turnBaseline?: GitWorkingTreeBaseline | null

  constructor(private readonly worker: WorkerConfig) {}

  async control(input: { action: string; text?: string }): Promise<unknown> {
    const { session, sessionManager } = await this.session()
    if (input.action === 'status') return { busy: this.busy, mode: 'default', goal: null }
    if (input.action === 'rewind') {
      if (this.busy || !input.text?.trim()) throw new Error('An idle session and original message are required')
      const branch = sessionManager.getBranch()
      const users = branch.filter((entry) => entry.type === 'message' && entry.message.role === 'user')
      const matches = users.filter((entry) => {
        if (entry.type !== 'message' || entry.message.role !== 'user') return false
        const content = entry.message.content
        return (typeof content === 'string' ? content : content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')) === input.text
      })
      if (!users.length) return { rewound: true }
      if (matches.length !== 1) throw new Error('Cannot unambiguously locate the original native message')
      const result = await session.navigateTree(matches[0]!.id, { summarize: false })
      if (result.cancelled || result.aborted) throw new Error('Native navigation was cancelled')
      if (sessionManager.getLeafId() !== matches[0]!.parentId) throw new Error('Native navigation did not reach the message parent')
      return { rewound: true }
    }
    if (input.action === 'steer') {
      if (!this.busy || !input.text?.trim()) throw new Error('An active turn and steering text are required')
      await session.steer(input.text)
      this.writeFrame({ type: 'openlink_user_steer', text: input.text, messageId: randomUUID() })
      return { accepted: true }
    }
    if (input.action === 'compact') {
      if (this.busy) throw new Error('Wait for the active turn to finish before compacting')
      this.busy = true
      try {
        await session.compact(input.text)
        return { compacted: true, nativeSession: { type: 'openlink_session_entries', header: sessionManager.getHeader(), entries: sessionManager.getEntries() } }
      } finally { this.busy = false }
    }
    throw new Error('This Pi runtime does not support the requested control')
  }

  /** Initialize Pi's native ModelRuntime, SessionManager and extensions during
   * lease warmup, matching Codex's process/thread readiness semantics. */
  async prepare(): Promise<void> {
    await this.session()
  }

  async resources(_request?: { scope?: 'command' | 'mention' | 'skill' | 'title'; command?: string; query?: string }) {
    const extensions = await availableExtensionPaths([
      this.worker.browserExtensionPath,
      this.worker.supabaseExtensionPath,
    ])
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.worker.workspaceRoot,
      agentDir: this.worker.sessionRoot,
      noExtensions: true,
      additionalExtensionPaths: extensions,
    })
    await resourceLoader.reload()
    const commands = [
      ...resourceLoader.getPrompts().prompts.map((prompt) => ({
        name: prompt.name,
        description: prompt.description,
        source: 'prompt' as const,
      })),
      ...resourceLoader.getSkills().skills.map((skill) => ({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: 'skill' as const,
      })),
    ]
    return {
      agent: 'pi' as const,
      source: 'Pi Resource Loader',
      accessMode: this.worker.accessMode,
      // Pi's Resource Loader has no image-generation extension in this
      // worker image. Keep this explicit so the composer never advertises a
      // local-only toggle as a usable capability.
      imageGeneration: false,
      extensions: extensions.map((path) => path.split('/').pop() || path),
      commands,
      mcpServers: this.worker.supabaseExtensionPath && extensions.includes(this.worker.supabaseExtensionPath)
        ? [{ id: 'openlink_supabase', name: 'OpenLink Supabase' }]
        : [],
    }
  }

  async prompt(message: string, response: ServerResponse, signal: AbortSignal, attachments: WorkerPromptAttachment[] = []): Promise<void> {
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
      const uploadedFiles = await stageCodexPromptFiles(this.worker.workspaceRoot, attachments.filter((attachment): attachment is Extract<WorkerPromptAttachment, { type: 'file' }> => attachment.type === 'file'))
      const protocol = piPromptProtocolInput(
        message,
        attachments.filter((attachment): attachment is Exclude<WorkerPromptAttachment, Extract<WorkerPromptAttachment, { type: 'file' }>> => attachment.type !== 'file'),
        uploadedFiles.map((attachment) => ({ name: String(attachment.name), path: String(attachment.path) })),
      )
      const previousEntryCount = sessionManager.getEntries().length
      // Report only what this turn changed: record the working tree before the
      // turn can touch it, the way Codex/ChatGPT clients checkpoint a turn.
      await this.turnBaseline?.dispose()
      this.turnBaseline = await createGitBaseline(this.worker.workspaceRoot)
      this.gitSnapshotSignature = undefined
      let eventQueue = Promise.resolve()
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      let rejectIdle!: (error: Error) => void
      const idleFailure = new Promise<never>((_resolve, reject) => { rejectIdle = reject })
      const touchTurn = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          void session.abort()
          rejectIdle(new Error(`Pi turn stopped emitting events for ${this.worker.turnIdleTimeoutMs}ms`))
        }, this.worker.turnIdleTimeoutMs)
        idleTimer.unref?.()
      }
      const filePaths = new Map<string, string>()
      const unsubscribe = session.subscribe((event) => {
        touchTurn()
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
          const snapshot = await collectGitSnapshot(this.worker.workspaceRoot, this.turnBaseline)
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
        touchTurn()
        await Promise.race([
          session.prompt(protocol.message, { source: 'rpc', ...(protocol.images.length ? { images: protocol.images } : {}) }),
          idleFailure,
        ])
      } catch (error) {
        canceled = signal.aborted || this.cancelRequested
        if (!canceled && error instanceof Error && error.message.startsWith('Pi turn stopped emitting events')) {
          this.sessionPromise = undefined
        }
        if (!canceled) throw error
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
        await eventQueue
        // Pi's abort path is allowed to settle without emitting
        // `agent_settled`. Send an explicit terminal frame so direct desktop
        // consumers (and the Web BFF drain path) never leave the turn looking
        // permanently Working after a canceled request.
        if ((canceled || signal.aborted || this.cancelRequested) && !response.writableEnded) {
          response.write(`${JSON.stringify({ type: 'extension_error', error: 'Agent request was canceled', terminal: true })}\n`)
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
    if (this.worker.browserExtensionPath && !this.worker.browserCapabilityFile) throw new Error('OpenLink browser capability file is required when the extension is enabled')
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
    providerId: worker.providerId,
    providerBaseUrl: worker.providerBaseUrl,
    accessMode: worker.accessMode,
    apiKey: worker.providerApiKey,
    supabaseMcpUrl: process.env.OPENLINK_SUPABASE_MCP_URL,
    supabaseMcpToken: process.env.OPENLINK_SUPABASE_MCP_TOKEN,
    browserMcpUrl: worker.browserCapabilityFile ? `http://127.0.0.1:${worker.port}/v1/browser-mcp` : undefined,
    turnIdleTimeoutMs: worker.turnIdleTimeoutMs,
  })
  : new SdkAgentRuntime(worker)
let lifecycleState: 'starting' | 'ready' | 'error' = 'starting'
let lifecycleError = ''
let preparePromise: Promise<void> | undefined

async function ensureRuntimeReady(): Promise<void> {
  if (lifecycleState === 'ready') return
  if (preparePromise) return preparePromise
  lifecycleState = 'starting'
  const operation = runtime.prepare()
    .then(() => {
      lifecycleState = 'ready'
      lifecycleError = ''
    })
    .catch((error) => {
      lifecycleState = 'error'
      lifecycleError = error instanceof Error ? error.message : String(error)
      throw error
    })
  preparePromise = operation
  try {
    await operation
  } finally {
    if (preparePromise === operation) preparePromise = undefined
  }
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    if (request.method === 'GET' && url.pathname === '/healthz') {
      const ready = lifecycleState === 'ready'
      response.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify({
        ok: ready,
        state: lifecycleState,
        runtime: worker.agent === 'codex' ? 'codex-app-server' : 'pi-node-sdk',
        ...(lifecycleState === 'error' ? { error: lifecycleError } : {}),
      }))
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
    if (request.method === 'POST' && url.pathname === '/v1/control') {
      const raw = await readRequestJson(request, 128 * 1024) as { action?: unknown; text?: unknown } | null
      if (!raw || typeof raw.action !== 'string' || !['status', 'steer', 'plan', 'default', 'goal', 'goal-clear', 'compact', 'rewind', 'fork'].includes(raw.action)
        || (raw.text !== undefined && (typeof raw.text !== 'string' || raw.text.length > 100000))) throw new Error('Invalid session control')
      await ensureRuntimeReady()
      const result = await runtime.control({ action: raw.action, text: raw.text as string | undefined })
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(result))
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/extension-ui-response') {
      const uiResponse = await readExtensionUiResponse(request)
      if (worker.agent === 'codex') {
        await (runtime as CodexAppServerRuntime).resolveApproval(uiResponse.id, uiResponse.confirmed === true, uiResponse.value)
      } else {
        await (runtime as SdkAgentRuntime).resolveExtensionUi(uiResponse)
      }
      response.writeHead(202, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify({ ok: true }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/browser-mcp') {
      if (!worker.browserCapabilityFile) throw new Error('Browser capability is not configured for this Agent')
      await handleBrowserMcpRequest(request, response, worker.browserCapabilityFile)
      return
    }
    if (request.method === 'PUT' && url.pathname === '/v1/browser-capability') {
      await writeBrowserCapability(await readBrowserCapability(request))
      response.writeHead(204, { 'Cache-Control': 'no-store' })
      response.end()
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/resources') {
      await ensureRuntimeReady()
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      const scope = url.searchParams.get('scope')
      response.end(JSON.stringify(await runtime.resources({
        ...(scope === 'command' || scope === 'mention' || scope === 'skill' ? { scope } : {}),
        ...(url.searchParams.has('command') ? { command: url.searchParams.get('command') ?? '' } : {}),
        ...(url.searchParams.has('query') ? { query: url.searchParams.get('query') ?? '' } : {}),
      })))
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/title') {
      const message = await readMessage(request)
      await ensureRuntimeReady()
      const result = await runtime.resources({ scope: 'title', query: message })
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(result))
      return
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/events') {
      response.writeHead(404).end()
      return
    }
    const { message, attachments } = await readPrompt(request)
    await ensureRuntimeReady()
    response.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-OpenLink-Agent-Worker': worker.agent === 'codex' ? 'codex-app-server' : 'pi-node-sdk',
    })
    response.flushHeaders?.()
    const abortController = new AbortController()
    response.once('close', () => { if (!response.writableEnded) abortController.abort() })
    await runtime.prompt(message, response, abortController.signal, attachments)
    response.end()
  })().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    if (response.headersSent) {
      if (!response.writableEnded) response.end(`${JSON.stringify({ type: 'extension_error', error: message, terminal: true })}\n`)
    } else {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: message }))
    }
  })
})

server.listen(worker.port, worker.host, () => {
  process.stdout.write(`OpenLink Agent Worker listening on http://${worker.host}:${worker.port}\n`)
  void ensureRuntimeReady().catch((error) => {
    console.error(`OpenLink Agent Worker initialization failed: ${error instanceof Error ? error.message : String(error)}`)
  })
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => process.exit(0)))
}
