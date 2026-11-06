import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

type JsonRpcId = string | number | null
type Args = Record<string, unknown>

interface DesktopTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  readOnly: boolean
  destructive?: boolean
  /** Build the constrained CLI argv used by the Project VM bridge. */
  argv: (args: Args) => string[]
}

const STRING = { type: 'string' }
const BOOLEAN = { type: 'boolean' }
const NUMBER = { type: 'number' }
const INTEGER = { type: 'integer' }

function optionalString(args: Args, key: string): string | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || value.includes('\0')) {
    throw new Error(`${key} must be a non-empty string`)
  }
  return value
}

function optionalBoolean(args: Args, key: string): boolean | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
  return value
}

function optionalNumber(args: Args, key: string, min: number, max: number): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} is out of range`)
  }
  return value
}

function requiredString(args: Args, key: string): string {
  const value = optionalString(args, key)
  if (!value) throw new Error(`${key} is required`)
  return value
}

function appTarget(args: Args): string[] {
  const output: string[] = []
  const app = optionalString(args, 'app')
  const windowId = optionalString(args, 'windowId')
  if (app) output.push('--app', app)
  if (windowId) output.push('--window-id', windowId)
  return output
}

function stringArray(args: Args, key: string, max = 32): string[] {
  const value = args[key]
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max) throw new Error(`${key} must be an array of at most ${max} strings`)
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.length > 4096 || entry.includes('\0')) throw new Error(`${key} contains an invalid string`)
    return entry
  })
}

const SAFE_BATCH_COMMANDS = new Set([
  'check', 'clear', 'click', 'collapse', 'expand', 'find', 'focus', 'get', 'is', 'launch',
  'list-apps', 'list-windows', 'press', 'scroll-to', 'select', 'set-value', 'snapshot',
  'status', 'toggle', 'type', 'uncheck', 'wait',
])

function batchCommands(args: Args): Array<{ command: string; args?: Record<string, unknown> }> {
  const value = args.commands
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new Error('commands must contain 1-64 entries')
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('batch entry is invalid')
    const record = entry as Record<string, unknown>
    if (typeof record.command !== 'string' || !SAFE_BATCH_COMMANDS.has(record.command)) throw new Error('batch command is not allowed')
    if (record.args !== undefined && (!record.args || typeof record.args !== 'object' || Array.isArray(record.args))) throw new Error('batch args must be an object')
    return { command: record.command, ...(record.args ? { args: record.args as Record<string, unknown> } : {}) }
  })
}

const TOOLS: DesktopTool[] = [
  {
    name: 'desktop_status',
    description: 'Report desktop automation health, permissions, supported surfaces, and agent-desktop version.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    argv: () => ['status'],
  },
  {
    name: 'desktop_list_apps',
    description: 'List running applications visible on the project desktop. Use before launching or snapshotting.',
    inputSchema: { type: 'object', properties: { app: STRING }, additionalProperties: false },
    readOnly: true,
    argv: (args) => ['list-apps', ...(optionalString(args, 'app') ? ['--app', optionalString(args, 'app')!] : [])],
  },
  {
    name: 'desktop_list_windows',
    description: 'List windows, optionally scoped to an application.',
    inputSchema: { type: 'object', properties: { app: STRING, windowId: STRING }, additionalProperties: false },
    readOnly: true,
    argv: (args) => ['list-windows', ...appTarget(args)],
  },
  {
    name: 'desktop_snapshot',
    description: 'Capture the accessibility tree with stable refs. Observe before acting and again after every UI change.',
    inputSchema: {
      type: 'object',
      properties: {
        app: STRING, windowId: STRING, surface: STRING, root: STRING,
        interactiveOnly: BOOLEAN, compact: BOOLEAN, skeleton: BOOLEAN, includeBounds: BOOLEAN,
        maxDepth: INTEGER, timeoutMs: INTEGER,
      },
      additionalProperties: false,
    },
    readOnly: true,
    argv: (args) => {
      const output = ['snapshot']
      output.push(...appTarget(args))
      const surface = optionalString(args, 'surface')
      const root = optionalString(args, 'root')
      if (surface) output.push('--surface', surface)
      if (root) output.push('--root', root)
      if (optionalBoolean(args, 'interactiveOnly') !== false) output.push('-i')
      if (optionalBoolean(args, 'compact') !== false) output.push('--compact')
      if (optionalBoolean(args, 'skeleton')) output.push('--skeleton')
      if (optionalBoolean(args, 'includeBounds')) output.push('--include-bounds')
      const maxDepth = optionalNumber(args, 'maxDepth', 1, 100)
      const timeoutMs = optionalNumber(args, 'timeoutMs', 100, 120_000)
      if (maxDepth !== undefined) output.push('--max-depth', String(Math.trunc(maxDepth)))
      if (timeoutMs !== undefined) output.push('--timeout-ms', String(Math.trunc(timeoutMs)))
      return output
    },
  },
  {
    name: 'desktop_find',
    description: 'Find an element by role, name, text, value, or root ref before widening to a full snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        app: STRING, windowId: STRING, surface: STRING, root: STRING,
        role: STRING, name: STRING, text: STRING, value: STRING,
        exact: BOOLEAN, first: BOOLEAN, count: BOOLEAN, limit: INTEGER, timeoutMs: INTEGER,
      },
      additionalProperties: false,
    },
    readOnly: true,
    argv: (args) => {
      const output = ['find']
      output.push(...appTarget(args))
      const surface = optionalString(args, 'surface')
      const root = optionalString(args, 'root')
      if (surface) output.push('--surface', surface)
      if (root) output.push('--root', root)
      for (const key of ['role', 'name', 'text', 'value']) {
        const value = optionalString(args, key)
        if (value) output.push(`--${key}`, value)
      }
      if (optionalBoolean(args, 'exact')) output.push('--exact')
      if (optionalBoolean(args, 'first')) output.push('--first')
      if (optionalBoolean(args, 'count')) output.push('--count')
      const limit = optionalNumber(args, 'limit', 1, 100)
      const timeoutMs = optionalNumber(args, 'timeoutMs', 100, 120_000)
      if (limit !== undefined) output.push('--limit', String(Math.trunc(limit)))
      if (timeoutMs !== undefined) output.push('--timeout-ms', String(Math.trunc(timeoutMs)))
      return output
    },
  },
  {
    name: 'desktop_click',
    description: 'Activate an element by its snapshot ref. Refs are snapshot-scoped; snapshot again after UI changes.',
    inputSchema: { type: 'object', properties: { ref: STRING, headed: BOOLEAN }, required: ['ref'], additionalProperties: false },
    readOnly: false,
    argv: (args) => [...(optionalBoolean(args, 'headed') ? ['--headed'] : []), 'click', requiredString(args, 'ref')],
  },
  {
    name: 'desktop_type',
    description: 'Type text into a snapshot ref, or set a field value. Re-read the field before retrying an uncertain write.',
    inputSchema: {
      type: 'object',
      properties: { ref: STRING, text: STRING, headed: BOOLEAN, intervalMs: INTEGER, timeoutMs: INTEGER },
      required: ['ref', 'text'], additionalProperties: false,
    },
    readOnly: false,
    argv: (args) => {
      const output = [...(optionalBoolean(args, 'headed') ? ['--headed'] : []), 'type', requiredString(args, 'ref'), requiredString(args, 'text')]
      const intervalMs = optionalNumber(args, 'intervalMs', 1, 2_000)
      const timeoutMs = optionalNumber(args, 'timeoutMs', 100, 120_000)
      if (intervalMs !== undefined) output.push('--interval-ms', String(Math.trunc(intervalMs)))
      if (timeoutMs !== undefined) output.push('--timeout-ms', String(Math.trunc(timeoutMs)))
      return output
    },
  },
  {
    name: 'desktop_set_value',
    description: 'Set an editable field value through its semantic value path.',
    inputSchema: { type: 'object', properties: { ref: STRING, value: STRING }, required: ['ref', 'value'], additionalProperties: false },
    readOnly: false,
    argv: (args) => ['set-value', requiredString(args, 'ref'), requiredString(args, 'value')],
  },
  {
    name: 'desktop_press',
    description: 'Send a keyboard shortcut or key to an application or the foreground window.',
    inputSchema: {
      type: 'object',
      properties: { key: STRING, app: STRING, windowId: STRING, headed: BOOLEAN },
      required: ['key'], additionalProperties: false,
    },
    readOnly: false,
    argv: (args) => [
      ...(optionalBoolean(args, 'headed') ? ['--headed'] : []),
      'press', requiredString(args, 'key'),
      ...appTarget(args),
    ],
  },
  {
    name: 'desktop_launch',
    description: 'Launch a native application and optionally wait for its window and activate it.',
    inputSchema: {
      type: 'object',
      properties: { app: STRING, args: { type: 'array', items: STRING }, activate: BOOLEAN, headed: BOOLEAN, timeoutMs: INTEGER },
      required: ['app'], additionalProperties: false,
    },
    readOnly: false,
    argv: (args) => {
      const output = [...(optionalBoolean(args, 'headed') ? ['--headed'] : []), 'launch', requiredString(args, 'app')]
      for (const value of stringArray(args, 'args')) output.push('--arg', value)
      if (optionalBoolean(args, 'activate')) output.push('--activate')
      const timeoutMs = optionalNumber(args, 'timeoutMs', 100, 120_000)
      if (timeoutMs !== undefined) output.push('--timeout', String(Math.trunc(timeoutMs)))
      return output
    },
  },
  {
    name: 'desktop_screenshot',
    description: 'Capture the desktop, an app, or a window. The image is returned as MCP image content.',
    inputSchema: {
      type: 'object',
      properties: { app: STRING, windowId: STRING, screen: INTEGER },
      additionalProperties: false,
    },
    readOnly: true,
    argv: (args) => {
      const output = ['screenshot']
      output.push(...appTarget(args))
      const screen = optionalNumber(args, 'screen', 0, 64)
      if (screen !== undefined) output.push('--screen', String(Math.trunc(screen)))
      return output
    },
  },
  {
    name: 'desktop_batch',
    description: 'Run an ordered batch of agent-desktop commands in one process. Use for action-then-wait sequences.',
    inputSchema: {
      type: 'object',
      properties: {
        commands: {
          type: 'array',
          items: {
            type: 'object',
            properties: { command: STRING, args: { type: 'object' } },
            required: ['command'],
            additionalProperties: false,
          },
        },
        stopOnError: BOOLEAN,
        timeoutMs: INTEGER,
      },
      required: ['commands'], additionalProperties: false,
    },
    readOnly: false,
    argv: (args) => {
      const output = ['batch', JSON.stringify(batchCommands(args))]
      if (optionalBoolean(args, 'stopOnError') !== false) output.push('--stop-on-error')
      const timeoutMs = optionalNumber(args, 'timeoutMs', 100, 120_000)
      if (timeoutMs !== undefined) output.push('--timeout-ms', String(Math.trunc(timeoutMs)))
      return output
    },
  },
]

interface BridgeResult {
  exitCode: number
  stdout: string
  stderr?: string
}

async function readBody(request: IncomingMessage, limit = 1_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > limit) throw new Error('Desktop MCP request is too large')
    chunks.push(value)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Desktop MCP request is invalid')
  return parsed as Record<string, unknown>
}

function invokeBridge(socketPath: string, argv: string[], signal?: AbortSignal): Promise<BridgeResult> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ argv }))
    const request = httpRequest({
      socketPath,
      path: '/run',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length },
      timeout: 125_000,
    }, (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 32_000_000) {
          request.destroy(new Error('Desktop bridge response is too large'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Desktop bridge returned HTTP ${response.statusCode}`))
          return
        }
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BridgeResult
          resolve({ exitCode: Number.isInteger(value.exitCode) ? value.exitCode : 1, stdout: String(value.stdout ?? ''), stderr: value.stderr })
        } catch {
          reject(new Error('Desktop bridge returned invalid JSON'))
        }
      })
    })
    request.once('error', reject)
    request.once('timeout', () => request.destroy(new Error('Desktop bridge timed out')))
    if (signal) {
      const abort = () => request.destroy(new Error('Desktop request was canceled'))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }
    request.end(payload)
  })
}

function json(response: ServerResponse, id: JsonRpcId, result?: unknown, error?: { code: number; message: string }): void {
  response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }))
}

function toolResult(tool: DesktopTool, bridge: BridgeResult) {
  let envelope: Record<string, unknown> | null = null
  try {
    envelope = JSON.parse(bridge.stdout) as Record<string, unknown>
  } catch {
    return { content: [{ type: 'text' as const, text: bridge.stdout || bridge.stderr || 'Desktop command returned no output' }], isError: bridge.exitCode !== 0 }
  }
  const ok = envelope?.ok === true
  const data = envelope?.data && typeof envelope.data === 'object' ? envelope.data as Record<string, unknown> : {}
  if (tool.name === 'desktop_screenshot' && ok && typeof data.data === 'string' && data.format === 'png') {
    return { content: [{ type: 'image' as const, mimeType: 'image/png', data: data.data }], isError: false }
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify(envelope) }], isError: bridge.exitCode !== 0 || !ok }
}

/** Streamable-HTTP MCP adapter over the Project VM's agent-desktop bridge.
 * The bridge remains the security boundary: this adapter builds argv from
 * typed fields, and the bridge enforces the command allowlist and limits. */
export async function handleDesktopMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  socketPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const body = await readBody(request)
  const id = (typeof body.id === 'string' || typeof body.id === 'number' || body.id === null) ? body.id : null
  const method = typeof body.method === 'string' ? body.method : ''
  if (method === 'initialize') {
    json(response, id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'openlink-desktop', version: '1.0.0' },
      instructions: 'Native Ubuntu desktop automation for this OpenLink project session. Prefer these tools for GUI work; observe before acting and again after each change. The cursor overlay starts automatically when the display server supports it. It cannot be changed or disabled through the agent tools; unsupported sessions run without it.',
    })
    return
  }
  if (method === 'notifications/initialized') {
    response.writeHead(202).end()
    return
  }
  if (method === 'ping') { json(response, id, {}); return }
  if (method === 'tools/list') {
    json(response, id, {
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive === true, idempotentHint: tool.readOnly, openWorldHint: true },
      })),
    })
    return
  }
  if (method !== 'tools/call') { json(response, id, undefined, { code: -32601, message: `Method not found: ${method}` }); return }
  const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params as Record<string, unknown> : {}
  const tool = TOOLS.find((candidate) => candidate.name === params.name)
  if (!tool) { json(response, id, undefined, { code: -32602, message: `Unknown tool: ${String(params.name)}` }); return }
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments as Args : {}
  try {
    const argv = tool.argv(args)
    const bridge = await invokeBridge(socketPath, argv, signal)
    json(response, id, toolResult(tool, bridge))
  } catch (error) {
    json(response, id, {
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    })
  }
}
