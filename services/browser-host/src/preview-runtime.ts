import { randomBytes } from 'node:crypto'
import {
  BROWSER_PROTOCOL_VERSION,
  type BrowserActionEnvelope,
  type BrowserActionResult,
  type BrowserPageState,
} from '@openlink/browser-protocol'
import { BrowserHostError } from './errors.js'
import type { BrowserRuntimeSession, BrowserSessionRuntimeContext } from './session-manager.js'
import { SshLocalForward, type SshLocalForwardSpec } from './ssh-tunnel.js'

export interface NativePreviewRuntimeOptions {
  targetUrl?: string
  /** Trusted internal upstream headers (for the OpenSandbox Project proxy). */
  targetHeaders?: Record<string, string>
  sshForward?: SshLocalForwardSpec
  publicBaseUrl: string
  parentOrigins: string[]
  requestTimeoutMs?: number
  pathMode?: 'strip-session-prefix' | 'preserve-session-prefix'
}

interface PendingCommand {
  resolve: (result: BrowserActionResult) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

function assertLoopbackTarget(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserHostError('INVALID_PREVIEW_TARGET', 'Preview target must use HTTP or HTTPS', 400)
  }
  if (!['127.0.0.1', 'localhost', '::1', '[::1]', 'host.containers.internal'].includes(url.hostname)) {
    throw new BrowserHostError('INVALID_PREVIEW_TARGET', 'Preview target must be a Project-local runtime', 400)
  }
  if (url.username || url.password) throw new BrowserHostError('INVALID_PREVIEW_TARGET', 'Preview target credentials are not allowed in the URL', 400)
  return url
}

export class NativePreviewRuntime implements BrowserRuntimeSession {
  readonly surface = 'native-preview' as const
  readonly bridgeNonce = randomBytes(24).toString('base64url')
  private readonly pending = new Map<string, PendingCommand>()
  private tunnel?: SshLocalForward
  private _target?: URL

  constructor(
    private readonly context: BrowserSessionRuntimeContext,
    private readonly options: NativePreviewRuntimeOptions,
  ) {}

  get target(): URL {
    if (!this._target) throw new BrowserHostError('PREVIEW_NOT_READY', 'Preview target is not ready', 409, true)
    return this._target
  }

  get targetHeaders(): Record<string, string> {
    return this.options.targetHeaders ?? {}
  }

  get sessionId(): string {
    return this.context.sessionId
  }

  get parentOrigins(): string[] {
    return this.options.parentOrigins
  }

  get allowedSocketOrigins(): string[] {
    const publicOrigin = new URL(this.options.publicBaseUrl).origin
    return [...new Set([...this.options.parentOrigins, publicOrigin, ...(this.options.parentOrigins.includes(publicOrigin) ? ['null'] : [])])]
  }

  get pathMode(): 'strip-session-prefix' | 'preserve-session-prefix' {
    return this.options.pathMode ?? 'strip-session-prefix'
  }

  get publicPath(): string {
    return `/v1/browser/sessions/${encodeURIComponent(this.context.sessionId)}/preview`
  }

  async start(): Promise<void> {
    if (this.options.sshForward) {
      this.tunnel = new SshLocalForward(this.options.sshForward)
      await this.tunnel.start()
      this._target = assertLoopbackTarget(this.tunnel.url)
    } else if (this.options.targetUrl) {
      this._target = assertLoopbackTarget(this.options.targetUrl)
    } else {
      throw new BrowserHostError('INVALID_PREVIEW_TARGET', 'targetUrl or sshForward is required', 400)
    }

    const page: BrowserPageState = {
      id: 'preview',
      url: `${this.options.publicBaseUrl}${this.publicPath}/`,
      title: 'Project preview',
      loading: false,
      canGoBack: true,
      canGoForward: true,
      active: true,
    }
    this.context.update((state) => ({
      ...state,
      status: 'ready',
      activePageId: page.id,
      pages: [page],
      previewUrl: `${this.options.publicBaseUrl}${this.publicPath}/__openlink_bootstrap`,
    }))
  }

  async perform(envelope: BrowserActionEnvelope): Promise<BrowserActionResult> {
    if (envelope.action.type === 'page.open') {
      throw new BrowserHostError('PREVIEW_SINGLE_PAGE', 'Native preview owns one page; navigate the preview page instead', 409)
    }
    if (envelope.action.type === 'page.close') {
      throw new BrowserHostError('PREVIEW_SINGLE_PAGE', 'Native preview page cannot be closed independently', 409)
    }
    if (envelope.action.type === 'page.screenshot' || envelope.action.type === 'dialog.handle') {
      throw new BrowserHostError('ACTION_REQUIRES_CHROMIUM', `${envelope.action.type} requires the Chromium surface`, 409, true)
    }

    const commandId = randomBytes(16).toString('base64url')
    const timeoutMs = this.options.requestTimeoutMs ?? 15_000
    const result = new Promise<BrowserActionResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(commandId)
        reject(new BrowserHostError('PREVIEW_CLIENT_TIMEOUT', 'No connected preview client completed the action', 504, true))
      }, timeoutMs)
      timeout.unref()
      this.pending.set(commandId, { resolve, reject, timeout })
    })
    this.context.emit({ type: 'bridge.command', commandId, action: envelope })
    return result
  }

  resolveBridgeResult(commandId: string, result: BrowserActionResult): void {
    const pending = this.pending.get(commandId)
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pending.delete(commandId)
    pending.resolve(result)
  }

  async close(): Promise<void> {
    for (const command of this.pending.values()) {
      clearTimeout(command.timeout)
      command.reject(new BrowserHostError('SESSION_CLOSED', 'Preview session closed', 410))
    }
    this.pending.clear()
    await this.tunnel?.close()
  }

  actionFailure(envelope: BrowserActionEnvelope, error: BrowserHostError): BrowserActionResult {
    return {
      version: BROWSER_PROTOCOL_VERSION,
      actionId: envelope.actionId,
      sessionId: envelope.sessionId,
      ok: false,
      error: { code: error.code, message: error.message, recoverable: error.recoverable },
    }
  }
}
