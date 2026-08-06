import { BROWSER_PROTOCOL_VERSION, type BrowserAction, type BrowserActionResult, type BrowserSessionState } from '@openlink/browser-protocol'
import { randomBytes } from 'node:crypto'
import { AgentHostError } from './errors.js'

export interface BrowserHostClientOptions {
  baseUrl: string
  serviceToken: string
  fetch?: typeof globalThis.fetch
}

export interface BrowserAgentSession {
  state: BrowserSessionState
  controlToken: string
}

export class BrowserHostClient {
  private readonly fetch: typeof globalThis.fetch
  private readonly baseUrl: string

  constructor(private readonly options: BrowserHostClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.fetch = options.fetch ?? globalThis.fetch
    if (!this.baseUrl || !options.serviceToken) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Browser Host URL and service token are required')
  }

  get runtimeUrl(): string {
    return this.baseUrl
  }

  async createChromiumSession(input: {
    ownerId: string
    workspaceId: string
    projectId: string
    initialUrl?: string
    viewport?: BrowserSessionState['viewport']
    allowedDomains?: string[]
    deniedDomains?: string[]
    allowLoopback?: boolean
    allowPrivateNetworks?: boolean
  }): Promise<BrowserAgentSession> {
    const response = await this.serviceRequest('/v1/browser/sessions', {
      method: 'POST',
      body: JSON.stringify({
        ownerId: input.ownerId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        surface: 'chromium-stream',
        viewport: input.viewport,
        chromium: {
          initialUrl: input.initialUrl ?? 'about:blank',
          headless: true,
          networkPolicy: {
            allowedDomains: input.allowedDomains ?? [],
            deniedDomains: input.deniedDomains ?? [],
            allowLoopback: input.allowLoopback ?? false,
            allowPrivateNetworks: input.allowPrivateNetworks ?? false,
          },
        },
      }),
    })
    const payload = await response.json() as { session?: BrowserSessionState; connection?: { controlToken?: string }; error?: { message?: string } }
    if (!response.ok || !payload.session || !payload.connection?.controlToken) {
      throw new AgentHostError('BROWSER_SESSION_FAILED', payload.error?.message ?? `Browser Host returned ${response.status}`)
    }
    return { state: payload.session, controlToken: payload.connection.controlToken }
  }

  async perform(session: BrowserAgentSession, action: BrowserAction): Promise<BrowserActionResult> {
    const response = await this.fetch(`${this.baseUrl}/v1/browser/sessions/${encodeURIComponent(session.state.id)}/actions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.controlToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: BROWSER_PROTOCOL_VERSION,
        actionId: randomBytes(16).toString('base64url'),
        sessionId: session.state.id,
        actor: 'agent',
        action,
      }),
    })
    const payload = await response.json() as { result?: BrowserActionResult; error?: { message?: string } }
    if (!response.ok || !payload.result) throw new AgentHostError('BROWSER_ACTION_FAILED', payload.error?.message ?? `Browser Host returned ${response.status}`)
    return payload.result
  }

  async close(sessionId: string): Promise<void> {
    const response = await this.serviceRequest(`/v1/browser/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
    if (!response.ok && response.status !== 404) throw new AgentHostError('BROWSER_SESSION_FAILED', `Browser Host returned ${response.status}`)
  }

  private serviceRequest(path: string, init: RequestInit): Promise<Response> {
    return this.fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.options.serviceToken}`, 'Content-Type': 'application/json', ...init.headers },
    })
  }
}
