import { createConnection, createServer, type Server } from 'node:net'
import { chmod, lstat, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { AgentHostError } from './errors.js'
import type { ProjectRuntimeController } from './project-runtime-router.js'
import type { ProjectRuntimeCloseOptions, ProjectRuntimeDescriptor, ProjectSupabaseManagementRequest, ProjectSupabaseStudioProxyRequest } from './project-runtime.js'

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const ACTIONS = new Set([
  'ensure', 'describeSupabase', 'manageSupabase', 'proxySupabaseStudio',
  'prepareSessionStorage', 'ensureProjectGitRepository', 'listGitVersions',
  'persistCodexThreadId',
  'listWorkspaceFiles', 'checkoutGitVersion', 'hasPersistedRuntime', 'restorePersistedRuntimes',
  'discoverPreviewTarget', 'close',
])

interface BrokerRequest { schemaVersion: 1; action: string; projectId?: string; payload?: unknown }
interface BrokerResponse { ok: boolean; result?: unknown; error?: string; code?: string; retryable?: boolean }

function validateProjectId(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_ID.test(value)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
  return value
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentHostError('INVALID_BODY', 'Project broker payload is invalid')
  return value as Record<string, unknown>
}

async function dispatch(controller: ProjectRuntimeController, request: BrokerRequest): Promise<unknown> {
  if (request.schemaVersion !== 1 || !ACTIONS.has(request.action)) throw new AgentHostError('INVALID_BODY', 'Project broker action is invalid')
  const id = request.action === 'restorePersistedRuntimes' || request.action === 'close' ? undefined : validateProjectId(request.projectId)
  const payload = request.payload === undefined ? {} : record(request.payload)
  switch (request.action) {
    case 'ensure': {
      const mode = payload.diskMode
      if (mode !== undefined && mode !== 'thin' && mode !== 'thick') throw new AgentHostError('INVALID_BODY', 'diskMode is invalid')
      return controller.ensure(id!, mode)
    }
    case 'describeSupabase': return controller.describeSupabase?.(id!) ?? null
    case 'manageSupabase': return controller.manageSupabase?.(id!, payload as ProjectSupabaseManagementRequest)
    case 'proxySupabaseStudio': return controller.proxySupabaseStudio?.(id!, payload as unknown as ProjectSupabaseStudioProxyRequest)
    case 'prepareSessionStorage': {
      const values = [payload.userId, payload.workspaceId, payload.sessionId]
      if (values.some((value) => typeof value !== 'string' || !IDENTIFIER.test(value))) throw new AgentHostError('INVALID_BODY', 'Session storage identity is invalid')
      return controller.prepareSessionStorage(id!, values[0] as string, values[1] as string, values[2] as string)
    }
    case 'persistCodexThreadId': {
      const values = [payload.userId, payload.workspaceId, payload.sessionId]
      if (values.some((value) => typeof value !== 'string' || !IDENTIFIER.test(value))) throw new AgentHostError('INVALID_BODY', 'Session storage identity is invalid')
      if (typeof payload.threadId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.threadId)) throw new AgentHostError('INVALID_BODY', 'Codex thread id is invalid')
      return controller.persistCodexThreadId(id!, values[0] as string, values[1] as string, values[2] as string, payload.threadId)
    }
    case 'ensureProjectGitRepository': return controller.ensureProjectGitRepository(id!)
    case 'listGitVersions': return controller.listGitVersions(id!)
    case 'listWorkspaceFiles': return controller.listWorkspaceFiles(id!)
    case 'checkoutGitVersion': {
      if (typeof payload.ref !== 'string' || (payload.ref !== 'latest' && !/^[a-f0-9]{7,40}$/i.test(payload.ref))) throw new AgentHostError('INVALID_BODY', 'Git ref is invalid')
      return controller.checkoutGitVersion(id!, payload.ref)
    }
    case 'hasPersistedRuntime': return controller.hasPersistedRuntime(id!)
    case 'restorePersistedRuntimes': return controller.restorePersistedRuntimes()
    case 'discoverPreviewTarget': return controller.discoverPreviewTarget(id!)
    case 'close': return controller.close({ stopRuntimes: payload.stopRuntimes === true })
  }
  throw new AgentHostError('INVALID_BODY', 'Project broker action is invalid')
}

export async function serveProjectContainerBroker(socketPath: string, controller: ProjectRuntimeController): Promise<{ socket: string; server: Server; close(): Promise<void> }> {
  const socket = resolve(socketPath)
  await mkdir(dirname(socket), { recursive: true, mode: 0o750 })
  const existing = await lstat(socket).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (existing && !existing.isSocket()) throw new Error(`Project container broker refuses to replace a non-socket path: ${socket}`)
  await rm(socket, { force: true })
  const server = createServer({ allowHalfOpen: true }, (connection) => {
    connection.setEncoding('utf8')
    connection.setTimeout(660_000, () => connection.destroy(new Error('Project container broker request timed out')))
    let input = ''
    connection.on('data', (chunk) => {
      input += chunk
      if (Buffer.byteLength(input) > 16 * 1024 * 1024) connection.destroy(new Error('Project container broker request is too large'))
    })
    connection.once('error', () => undefined)
    connection.once('end', async () => {
      if (connection.destroyed) return
      try {
        const frames = input.split('\n').filter(Boolean)
        if (!input.endsWith('\n') || frames.length !== 1) throw new AgentHostError('INVALID_BODY', 'Project broker accepts one request')
        const request = JSON.parse(frames[0]!) as BrokerRequest
        const result = await dispatch(controller, request)
        connection.end(`${JSON.stringify({ ok: true, result } satisfies BrokerResponse)}\n`)
      } catch (error) {
        const failure = error instanceof AgentHostError ? error : new AgentHostError('PROJECT_BACKEND_UNAVAILABLE', error instanceof Error ? error.message : String(error), { retryable: true })
        connection.end(`${JSON.stringify({ ok: false, error: failure.message, code: failure.code, retryable: failure.retryable } satisfies BrokerResponse)}\n`)
      }
    })
  })
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(socket, accept) })
  await chmod(socket, 0o660)
  return {
    socket, server,
    async close() {
      await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()))
      await rm(socket, { force: true })
    },
  }
}

export class ProjectContainerBrokerClient implements ProjectRuntimeController {
  private readonly socketPath: string
  private readonly active = new Map<string, ProjectRuntimeDescriptor>()

  constructor(socketPath: string) { this.socketPath = resolve(socketPath) }

  private request<T>(action: string, projectId?: string, payload?: Record<string, unknown>): Promise<T> {
    return new Promise<T>((accept, reject) => {
      const client = createConnection(this.socketPath)
      let response = ''
      const timer = setTimeout(() => client.destroy(new Error('Project container broker request timed out')), 660_000)
      client.setEncoding('utf8')
      client.once('connect', () => client.end(`${JSON.stringify({ schemaVersion: 1, action, ...(projectId ? { projectId } : {}), ...(payload ? { payload } : {}) })}\n`))
      client.on('data', (chunk) => {
        response += chunk
        if (Buffer.byteLength(response) > 16 * 1024 * 1024) client.destroy(new Error('Project container broker response is too large'))
      })
      client.once('error', (error) => { clearTimeout(timer); reject(error) })
      client.once('end', () => {
        clearTimeout(timer)
        try {
          const result = JSON.parse(response) as BrokerResponse
          if (!result.ok) throw new AgentHostError((result.code as never) || 'PROJECT_BACKEND_UNAVAILABLE', result.error || 'Project container broker rejected the request', { retryable: result.retryable })
          accept(result.result as T)
        } catch (error) { reject(error) }
      })
    })
  }

  async ensure(projectId: string, requestedDiskMode?: 'thin' | 'thick') { const value = await this.request<ProjectRuntimeDescriptor>('ensure', projectId, requestedDiskMode ? { diskMode: requestedDiskMode } : undefined); this.active.set(projectId, value); return value }
  describeSupabase(projectId: string) { return this.request<ProjectRuntimeDescriptor['supabase'] | null>('describeSupabase', projectId) }
  manageSupabase(projectId: string, request: ProjectSupabaseManagementRequest) { return this.request<Record<string, unknown>>('manageSupabase', projectId, request) }
  proxySupabaseStudio(projectId: string, request: ProjectSupabaseStudioProxyRequest) { return this.request<Awaited<ReturnType<NonNullable<ProjectRuntimeController['proxySupabaseStudio']>>>>('proxySupabaseStudio', projectId, request as unknown as Record<string, unknown>) }
  prepareSessionStorage(projectId: string, userId: string, workspaceId: string, sessionId: string) { return this.request<string>('prepareSessionStorage', projectId, { userId, workspaceId, sessionId }) }
  async persistCodexThreadId(projectId: string, userId: string, workspaceId: string, sessionId: string, threadId: string) { await this.request('persistCodexThreadId', projectId, { userId, workspaceId, sessionId, threadId }) }
  async ensureProjectGitRepository(projectId: string) { await this.request('ensureProjectGitRepository', projectId) }
  listGitVersions(projectId: string) { return this.request<Awaited<ReturnType<ProjectRuntimeController['listGitVersions']>>>('listGitVersions', projectId) }
  listWorkspaceFiles(projectId: string) { return this.request<string[]>('listWorkspaceFiles', projectId) }
  checkoutGitVersion(projectId: string, ref: string) { return this.request<Awaited<ReturnType<ProjectRuntimeController['checkoutGitVersion']>>>('checkoutGitVersion', projectId, { ref }) }
  getActive(projectId: string) { return this.active.get(projectId) }
  hasPersistedRuntime(projectId: string) { return this.request<boolean>('hasPersistedRuntime', projectId) }
  async restorePersistedRuntimes() { await this.request('restorePersistedRuntimes') }
  discoverPreviewTarget(projectId: string) { return this.request<Awaited<ReturnType<ProjectRuntimeController['discoverPreviewTarget']>>>('discoverPreviewTarget', projectId) }
  async close(options: ProjectRuntimeCloseOptions = {}) { await this.request('close', undefined, { stopRuntimes: options.stopRuntimes === true }); this.active.clear() }
}
