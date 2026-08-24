import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

export type ProjectSupabaseManagementOperation =
  | 'tables'
  | 'database'
  | 'query'
  | 'auth-users'
  | 'storage-buckets'
  | 'functions'
  | 'realtime'
  | 'services'
  | 'logs'

type JsonRpcId = string | number | null
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

interface JsonRpcRequest {
  jsonrpc?: unknown
  id?: JsonRpcId
  method?: unknown
  params?: unknown
}

const MCP_PROTOCOL_VERSION = '2025-06-18'
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05'])
const CAPABILITY_TTL_MS = 24 * 60 * 60 * 1_000

interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  operation: ProjectSupabaseManagementOperation
  /** Argument name promoted into the management request body, if any. */
  argument?: 'query' | 'service'
}

const TOOLS: McpToolDefinition[] = [
  { name: 'supabase_list_tables', description: 'List every table visible in the project PostgreSQL (information_schema), including auth.* and storage.* schemas.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, operation: 'tables' },
  { name: 'supabase_database_info', description: 'Read PostgreSQL version, database size and active connection count for the project backend.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, operation: 'database' },
  { name: 'supabase_execute_sql', description: 'Run a single READ-ONLY SQL statement (SELECT) against the project PostgreSQL. INSERT/UPDATE/DELETE/DDL and multi-statements are rejected by the server.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Single read-only SQL statement' } }, required: ['query'], additionalProperties: false }, operation: 'query', argument: 'query' },
  { name: 'supabase_list_auth_users', description: 'List Auth (GoTrue) users with sanitized profiles.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, operation: 'auth-users' },
  { name: 'supabase_list_storage_buckets', description: 'List Storage buckets and their visibility.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, operation: 'storage-buckets' },
  { name: 'supabase_list_edge_functions', description: 'List Edge Functions present in the project workspace.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, operation: 'functions' },
  { name: 'supabase_realtime_status', description: 'Read Realtime channels/broadcast status.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, operation: 'realtime' },
  { name: 'supabase_list_services', description: 'Read the health of every managed Supabase service inside the Project VM.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, operation: 'services' },
  { name: 'supabase_get_logs', description: 'Read the latest log lines of one managed service (default: rest). Secrets are redacted inside the VM.', inputSchema: { type: 'object', properties: { service: { type: 'string', description: 'Service name such as rest, db, auth, storage' } }, additionalProperties: false }, operation: 'logs', argument: 'service' },
]

/** Scoped, short-lived capability so the in-VM agent never holds the global Agent Host secret. */
export function mintSupabaseMcpToken(secret: string, projectId: string, ttlMs = CAPABILITY_TTL_MS, now = Date.now()): string {
  const expiresAt = now + ttlMs
  const payload = Buffer.from(JSON.stringify({ version: 1, projectId, expiresAt }), 'utf8').toString('base64url')
  return `${payload}.${createHmac('sha256', secret).update(`openlink:supabase-mcp:v1:${payload}`).digest('base64url')}`
}

export function verifySupabaseMcpToken(secret: string, token: string | undefined, projectId: string, now = Date.now()): boolean {
  if (!token || token.length > 2_048) return false
  const [payload, supplied, ...extra] = token.split('.')
  if (!payload || !supplied || extra.length) return false
  const expected = createHmac('sha256', secret).update(`openlink:supabase-mcp:v1:${payload}`).digest('base64url')
  const expectedBytes = Buffer.from(expected)
  const suppliedBytes = Buffer.from(supplied)
  if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) return false
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { version?: unknown; projectId?: unknown; expiresAt?: unknown }
    return parsed.version === 1 && parsed.projectId === projectId && typeof parsed.expiresAt === 'number' && parsed.expiresAt > now
  } catch {
    return false
  }
}

function bearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization
  const raw = Array.isArray(header) ? header[0] : header
  return raw?.startsWith('Bearer ') ? raw.slice('Bearer '.length).trim() : undefined
}

export interface SupabaseMcpRequestOptions {
  request: IncomingMessage
  response: ServerResponse
  projectId: string
  apiToken: string
  /** Executes one management operation through the Project VM controller. */
  manage: (operation: ProjectSupabaseManagementOperation, extra: { query?: string; service?: string }) => Promise<Record<string, unknown>>
}

/**
 * Streamable-HTTP MCP endpoint (JSON responses, no SSE stream) exposing the
 * read-only Project Supabase management operations as MCP tools. Requests are
 * authorized either by the internal Agent Host Bearer token or by a project
 * scoped capability minted for the in-VM agent session.
 */
export async function handleSupabaseMcpRequest(options: SupabaseMcpRequestOptions): Promise<void> {
  const { request, response, projectId, apiToken, manage } = options
  const internal = bearer(request) === apiToken
  const capabilityValid = verifySupabaseMcpToken(apiToken, bearer(request), projectId)
  if (!internal && !capabilityValid) {
    response.writeHead(403, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: 'AUTH_DENIED' }))
    return
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'MCP endpoint accepts POST only' } }))
    return
  }

  let body: JsonRpcRequest
  try {
    const raw = await readBody(request)
    body = JSON.parse(raw) as JsonRpcRequest
  } catch {
    response.writeHead(400, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
    return
  }
  const id = body.id ?? null
  const isNotification = body.id === undefined
  const method = typeof body.method === 'string' ? body.method : ''

  const reply = (result: unknown): void => {
    if (isNotification) {
      response.writeHead(202).end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
  }
  const replyError = (code: number, message: string): void => {
    if (isNotification) {
      response.writeHead(202).end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }))
  }

  try {
    switch (method) {
      case 'initialize': {
        const requested = (body.params as { protocolVersion?: unknown } | undefined)?.protocolVersion
        const protocolVersion = typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : MCP_PROTOCOL_VERSION
        reply({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'openlink-project-supabase', version: '1.0.0' },
          instructions: 'Read-only management tools for the Supabase backend running inside this project VM. SQL is limited to single read-only statements; secrets never leave the VM.',
        })
        return
      }
      case 'notifications/initialized':
        reply(null)
        return
      case 'ping':
        reply({})
        return
      case 'tools/list':
        reply({
          tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        })
        return
      case 'tools/call': {
        const params = body.params as { name?: unknown; arguments?: Record<string, unknown> } | undefined
        const tool = TOOLS.find((candidate) => candidate.name === params?.name)
        if (!tool) {
          replyError(-32602, `Unknown tool: ${String(params?.name)}`)
          return
        }
        const args = params?.arguments ?? {}
        const extra: { query?: string; service?: string } = {}
        if (tool.argument === 'query') {
          const query = args.query
          if (typeof query !== 'string' || !query.trim()) {
            replyError(-32602, 'query is required')
            return
          }
          extra.query = query.slice(0, 12_000)
        }
        if (tool.argument === 'service') {
          const service = args.service
          if (service !== undefined && typeof service !== 'string') {
            replyError(-32602, 'service must be a string')
            return
          }
          if (typeof service === 'string') extra.service = service.slice(0, 64)
        }
        const result = await manage(tool.operation, extra)
        reply({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: false })
        return
      }
      default:
        replyError(-32601, `Method not found: ${method}`)
    }
  } catch (error) {
    replyError(-32000, error instanceof Error ? error.message.slice(0, 500) : 'Management call failed')
  }
}

async function readBody(request: IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('MCP request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}
