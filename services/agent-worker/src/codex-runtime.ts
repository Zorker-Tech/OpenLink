import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { relative, resolve } from 'node:path'
import { access, mkdir, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toolMayMutateWorkspace(toolName: string): boolean {
  return /(?:^|[-_ ])(edit|write|patch|file|bash|shell|terminal|command)(?:$|[-_ ])/i.test(toolName)
}

function filePathFromCommandItem(item: Record<string, unknown>): string {
  const command = stringValue(item.command)
  // Codex reports shell commands; infer the touched path only from explicit
  // file-patch items. Command items just trigger the observational git probe.
  void command
  return ''
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
    if (relative(workspaceRoot, absolutePath).startsWith('..')) continue
    let patch = ''
    if (untrackedPaths.includes(path)) {
      try {
        const source = await readFile(absolutePath)
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
    signature: JSON.stringify({ baseCommit, files }),
  }
}

export interface CodexRuntimeConfig {
  workspaceRoot: string
  sessionRoot: string
  codexHome: string
  codexBin: string
  model?: string
  /** 'restricted' -> read-only sandbox, 'ask' -> workspace-write + approvals, 'open' -> danger-full-access */
  accessMode: 'restricted' | 'ask' | 'open'
  apiKey?: string
  supabaseMcpUrl?: string
  supabaseMcpToken?: string
}

interface PendingCodexApproval {
  resolve(decision: 'approved' | 'denied'): void
}

interface PendingCodexRequest {
  id: string
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
}

/**
 * Long-lived `codex app-server` runtime. Speaks the bidirectional JSON-RPC
 * (no "jsonrpc" field on the wire) protocol over stdio, exactly as the VS Code
 * extension does. Codex enforces its own sandbox, so OpenLink's access
 * firewall is intentionally bypassed here: the session's access mode maps
 * directly onto Codex sandbox/approval flags.
 */
export class CodexAppServerRuntime {
  private child?: ChildProcessWithoutNullStreams
  private threadId: string | null = null
  private busy = false
  private cancelRequested = false
  private activeAbort?: () => void
  private activeResponse?: ServerResponse
  private activeSignal?: AbortSignal
  private readonly pendingApprovals = new Map<string, PendingCodexApproval>()
  private readonly pendingRequests = new Map<string, PendingCodexRequest>()
  private notificationBuffer = ''
  private nextRequestId = 1
  private gitSnapshotSignature?: string
  private started = false

  constructor(private readonly config: CodexRuntimeConfig) {}

  healthz(): boolean {
    return true
  }

  cancel(): boolean {
    if (!this.busy) return false
    this.cancelRequested = true
    this.activeAbort?.()
    return true
  }

  async resolveApproval(approvalId: string, approved: boolean): Promise<void> {
    const pending = this.pendingApprovals.get(approvalId)
    if (!pending) throw new Error('No active codex approval request matches this response')
    this.pendingApprovals.delete(approvalId)
    pending.resolve(approved ? 'approved' : 'denied')
  }

  async start(): Promise<void> {
    if (this.started) return
    await mkdir(this.config.sessionRoot, { recursive: true, mode: 0o700 })
    await mkdir(this.config.codexHome, { recursive: true, mode: 0o700 })
    const child = spawn(this.config.codexBin, ['app-server', '--stdio'], {
      cwd: this.config.workspaceRoot,
      env: {
        ...process.env,
        CODEX_HOME: this.config.codexHome,
        ...(this.config.apiKey ? { OPENAI_API_KEY: this.config.apiKey } : {}),
        RUST_LOG: 'error',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.on('data', (chunk: string) => {
      const text = String(chunk).trim()
      if (text) console.error(`OpenLink codex app-server stderr: ${text.slice(0, 2000)}`)
    })
    child.once('exit', (code, signal) => {
      this.started = false
      this.threadId = null
      console.error(`OpenLink codex app-server exited (${code ?? signal ?? 'unknown'})`)
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error('Codex app-server exited'))
      }
      this.pendingRequests.clear()
    })
    // Handshake before any other request.
    await this.request('initialize', {
      clientInfo: { name: 'openlink_app', title: 'OpenLink App', version: '0.1.0' },
    })
    this.notify('initialized', {})
    this.started = true
  }

  private onStdout(chunk: string): void {
    this.notificationBuffer += chunk
    let newline = this.notificationBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.notificationBuffer.slice(0, newline).trim()
      this.notificationBuffer = this.notificationBuffer.slice(newline + 1)
      if (line) this.onFrame(line)
      newline = this.notificationBuffer.indexOf('\n')
    }
  }

  private onFrame(line: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      console.error('OpenLink codex app-server emitted a non-JSON frame')
      return
    }
    const record = asRecord(frame)
    if (!record) return
    // Responses to our requests resolve pending promises.
    if ('id' in record && (record.result !== undefined || record.error !== undefined)) {
      const pending = this.pendingRequests.get(String(record.id))
      if (pending) {
        this.pendingRequests.delete(String(record.id))
        if (record.error !== undefined) {
          const error = asRecord(record.error)
          pending.reject(new Error(stringValue(error?.message) || 'Codex request failed'))
        } else {
          pending.resolve(record.result)
        }
      }
      return
    }
    // Server->client requests (approvals) resolve through the pending map.
    const method = stringValue(record.method)
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      const params = asRecord(record.params) ?? {}
      const approvalKind = method === 'execCommandApproval' ? 'exec' : 'patch'
      const approvalId = `${approvalKind}:${stringValue(String(record.id))}`
      this.pendingApprovals.set(approvalId, {
        resolve: (decision) => {
          this.respond(String(record.id), { decision })
        },
      })
      this.emitToUi({ type: 'extension_ui_request', id: approvalId, method: 'confirm', title: '执行确认', message: `Codex ${approvalKind === 'exec' ? '请求执行命令' : '请求应用文件修改'}：${stringValue(params.command) || stringValue(params.reason) || '未提供详情'}` })
      return
    }
    // Everything else is a notification for the active turn.
    this.onNotification(method, asRecord(record.params) ?? {})
  }

  private respond(id: string, result: unknown): void {
    if (!this.child || this.child.killed) return
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`)
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    if (!this.child || this.child.killed) throw new Error('Codex app-server is not running')
    const id = this.nextRequestId++
    return new Promise((resolveValue, rejectValue) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(String(id))
        rejectValue(new Error(`Codex request ${method} timed out`))
      }, 120_000)
      timeout.unref?.()
      this.pendingRequests.set(String(id), {
        id: String(id),
        method,
        resolve: (value) => { clearTimeout(timeout); resolveValue(value) },
        reject: (error) => { clearTimeout(timeout); rejectValue(error) },
      })
      this.child!.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  private notify(method: string, params: unknown): void {
    if (!this.child || this.child.killed) return
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`)
  }

  private emitToUi(value: unknown): boolean {
    const response = this.activeResponse
    if (!response || response.writableEnded || response.destroyed) return false
    try {
      response.write(`${JSON.stringify(value)}\n`)
      return true
    } catch {
      return false
    }
  }

  private cancelPendingApprovals(): void {
    if (!this.pendingApprovals.size) return
    for (const [id] of this.pendingApprovals) {
      this.emitToUi({ type: 'openlink_confirmation_resolved', id, cancelled: true })
    }
    this.pendingApprovals.clear()
  }

  private sandboxPolicyFor(): Record<string, unknown> {
    if (this.config.accessMode === 'open') {
      return { mode: 'danger-full-access' }
    }
    if (this.config.accessMode === 'restricted') {
      return { mode: 'read-only' }
    }
    return { mode: 'workspace-write', network_access: false }
  }

  private approvalPolicyFor(): string {
    return this.config.accessMode === 'ask' ? 'on-request' : 'never'
  }

  private async ensureThread(): Promise<string> {
    if (this.threadId) return this.threadId
    const result = await this.request('thread/start', {
      cwd: this.config.workspaceRoot,
      sandbox: this.sandboxPolicyFor(),
      approvalPolicy: this.approvalPolicyFor(),
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(this.config.supabaseMcpUrl && this.config.supabaseMcpToken ? {
        config: {
          mcp_servers: {
            openlink_supabase: {
              url: this.config.supabaseMcpUrl,
              bearer_token_env_var: 'OPENLINK_SUPABASE_MCP_TOKEN',
            },
          },
        },
      } : {}),
    }) as Record<string, unknown> | undefined
    const thread = asRecord(result?.thread)
    const id = stringValue(thread?.id)
    if (!id) throw new Error('Codex thread/start did not return a thread id')
    this.threadId = id
    return id
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    const turnId = stringValue(params.turnId) || stringValue(params.turn_id)
    void turnId

    switch (method) {
      case 'turn/started':
        this.emitToUi({ type: 'turn_started', threadId: stringValue(params.threadId) })
        return
      case 'turn/completed':
        this.emitToUi({ type: 'turn_completed', usage: asRecord(params.usage) })
        return
      case 'turn/failed': {
        const error = asRecord(params.error)
        this.emitToUi({ type: 'extension_error', error: stringValue(error?.message) || 'Codex turn failed' })
        return
      }
      case 'item/started':
      case 'item/completed': {
        const item = asRecord(params.item)
        if (!item) return
        const itemType = stringValue(item.type)
        const itemId = stringValue(item.id)
        const completed = method === 'item/completed'

        if (itemType === 'reasoning') {
          const text = [item.summary, item.content].flat().filter(stringValue).join('\n')
          this.emitToUi(completed
            ? { type: 'codex_item', item: 'reasoning', phase: completed ? 'completed' : 'editing', id: itemId, text }
            : { type: 'codex_item', item: 'reasoning', phase: 'editing', id: itemId, text })
          return
        }
        if (itemType === 'agent_message' && completed) {
          this.emitToUi({ type: 'codex_item', item: 'agent_message', phase: 'completed', id: itemId, text: stringValue(item.text) })
          return
        }
        if (itemType === 'command_execution') {
          if (completed) {
            this.emitToUi({ type: 'codex_item', item: 'command_execution', phase: 'completed', id: itemId, command: stringValue(item.command), output: stringValue(item.aggregatedOutput), exitCode: item.exitCode })
          }
          void filePathFromCommandItem(item)
          void this.maybeGitSnapshot(itemId)
          return
        }
        if (itemType === 'file_change' && completed) {
          void this.maybeGitSnapshot(itemId)
          return
        }
        if (itemType === 'mcp_tool_call' && completed) {
          this.emitToUi({ type: 'codex_item', item: 'mcp_tool_call', phase: 'completed', id: itemId, server: stringValue(item.server), tool: stringValue(item.tool), result: item.result, error: item.error })
          return
        }
        if (itemType === 'error') {
          this.emitToUi({ type: 'extension_error', error: stringValue(item.message) || 'Codex reported an error item' })
        }
        return
      }
      case 'item/agentMessage/delta': {
        const delta = stringValue(params.delta)
        if (delta) this.emitToUi({ type: 'codex_delta', item: 'agent_message', id: stringValue(params.itemId), delta })
        return
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const delta = stringValue(params.delta)
        if (delta) this.emitToUi({ type: 'codex_delta', item: 'reasoning', id: stringValue(params.itemId), delta })
        return
      }
      case 'item/commandExecution/outputDelta': {
        const delta = stringValue(params.delta)
        if (delta) this.emitToUi({ type: 'codex_delta', item: 'command_execution', id: stringValue(params.itemId), delta })
        return
      }
      case 'error': {
        const error = asRecord(params.error)
        this.emitToUi({ type: 'extension_error', error: stringValue(error?.message) || 'Codex reported an error' })
        return
      }
      default:
        return
    }
  }

  private async maybeGitSnapshot(toolCallId: string): Promise<void> {
    const snapshot = await gitSnapshot(this.config.workspaceRoot)
    if (!snapshot || (!snapshot.files.length && !this.gitSnapshotSignature)) return
    if (snapshot.signature === this.gitSnapshotSignature) return
    this.gitSnapshotSignature = snapshot.signature
    snapshot.toolCallId = toolCallId
    this.emitToUi(snapshot)
  }

  async prompt(message: string, response: ServerResponse, signal: AbortSignal): Promise<void> {
    if (this.busy) throw new Error('Agent is already processing a prompt')
    this.busy = true
    this.activeResponse = response
    this.activeSignal = signal
    try {
      await this.start()
      const threadId = await this.ensureThread()
      // Install the completion waiter BEFORE dispatching turn/start so the
      // turn/completed notification can never race ahead of the listener.
      const completion = this.waitForTurnCompletion(signal)
      const abort = () => { void this.request('turn/interrupt', { threadId }).catch(() => undefined) }
      this.activeAbort = abort
      if (this.cancelRequested) abort()
      signal.addEventListener('abort', abort, { once: true })
      let canceled = false
      try {
        await this.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: message }],
        })
        await completion
      } catch (error) {
        canceled = signal.aborted || this.cancelRequested
        if (!canceled) throw error
      } finally {
        if ((canceled || signal.aborted || this.cancelRequested) && !response.writableEnded) {
          response.write(`${JSON.stringify({ type: 'extension_error', error: 'Agent request was canceled' })}\n`)
        }
        this.cancelRequested = false
        signal.removeEventListener('abort', abort)
        if (this.activeAbort === abort) this.activeAbort = undefined
        this.cancelPendingApprovals()
      }
    } finally {
      this.busy = false
      this.cancelRequested = false
      this.activeResponse = undefined
      this.activeSignal = undefined
      this.cancelPendingApprovals()
    }
  }

  private waitForTurnCompletion(signal: AbortSignal): Promise<void> {
    return new Promise((resolveValue, rejectValue) => {
      const onFrame = (method: string, frameParams: Record<string, unknown>) => {
        if (method === 'turn/completed' || method === 'turn/failed') {
          cleanup()
          if (method === 'turn/failed') rejectValue(new Error('Codex turn failed'))
          else resolveValue()
          return
        }
        if (method === 'error') {
          cleanup()
          const error = asRecord(frameParams.error)
          rejectValue(new Error(stringValue(error?.message) || 'Codex turn errored'))
        }
      }
      const originalOnFrame = this.onNotification.bind(this)
      this.onNotification = (method: string, params: Record<string, unknown>) => {
        onFrame(method, params)
        originalOnFrame(method, params)
      }
      const cleanup = () => {
        this.onNotification = originalOnFrame
        signal.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        cleanup()
        resolveValue()
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}

/** Shared workspace-bound helpers kept identical to the Pi worker's snapshot
 * contract so the UI timeline renders the same frames for both agents. */
export async function codexWorkspaceReady(workspaceRoot: string): Promise<boolean> {
  try {
    await access(workspaceRoot)
    return true
  } catch {
    return false
  }
}

// Re-exported so main.ts can reuse the same preview semantics without
// duplicating constants.
export const CODEX_PREVIEW_LIMIT = FILE_PREVIEW_LIMIT
export type CodexPreviewFrame = Record<string, unknown>
export const createCodexServerSentinel = (port: number, host: string) =>
  createServer(() => undefined).listen(port, host)
export const codexTimingSafeEqual = timingSafeEqual
export const codexRelative = relative
