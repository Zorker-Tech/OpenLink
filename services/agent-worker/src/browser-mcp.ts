import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'

type JsonRpcId = string | number | null

interface BrowserCapability {
  hostUrl: string
  sessionId: string
  controlToken: string
}

interface BrowserMcpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  readOnly: boolean
  action: (argumentsValue: Record<string, unknown>) => Record<string, unknown>
}

const TOOLS: BrowserMcpTool[] = [
  {
    name: 'browser_open',
    description: 'Open an absolute URL in the browser bound to this OpenLink session and return its page id.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
    readOnly: false,
    action: (args) => ({ type: 'page.open', url: args.url }),
  },
  {
    name: 'browser_read',
    description: 'Read the structured accessibility and DOM snapshot for a browser page.',
    inputSchema: { type: 'object', properties: { pageId: { type: 'string' } }, required: ['pageId'], additionalProperties: false },
    readOnly: true,
    action: (args) => ({ type: 'page.read', pageId: args.pageId }),
  },
  {
    name: 'browser_navigate',
    description: 'Navigate an existing browser page to an absolute URL.',
    inputSchema: { type: 'object', properties: { pageId: { type: 'string' }, url: { type: 'string' } }, required: ['pageId', 'url'], additionalProperties: false },
    readOnly: false,
    action: (args) => ({ type: 'page.navigate', pageId: args.pageId, url: args.url }),
  },
  {
    name: 'browser_click',
    description: 'Click a browser element using a snapshot ref, selector, or viewport coordinates.',
    inputSchema: { type: 'object', properties: { pageId: { type: 'string' }, ref: { type: 'string' }, selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'middle', 'right'] } }, required: ['pageId'], additionalProperties: false },
    readOnly: false,
    action: (args) => ({ type: 'element.click', ...args }),
  },
  {
    name: 'browser_type',
    description: 'Replace an editable browser element value and optionally submit it.',
    inputSchema: { type: 'object', properties: { pageId: { type: 'string' }, ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['pageId', 'text'], additionalProperties: false },
    readOnly: false,
    action: (args) => ({ type: 'element.type', ...args }),
  },
  {
    name: 'browser_screenshot',
    description: 'Capture a browser page screenshot.',
    inputSchema: { type: 'object', properties: { pageId: { type: 'string' }, fullPage: { type: 'boolean' } }, required: ['pageId'], additionalProperties: false },
    readOnly: true,
    action: (args) => ({ type: 'page.screenshot', ...args }),
  },
]

async function readBody(request: IncomingMessage, limit = 1_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > limit) throw new Error('Browser MCP request is too large')
    chunks.push(value)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Browser MCP request is invalid')
  return parsed as Record<string, unknown>
}

async function capability(path: string): Promise<BrowserCapability> {
  const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> | null
  if (!value || typeof value.hostUrl !== 'string' || typeof value.sessionId !== 'string' || typeof value.controlToken !== 'string') {
    throw new Error('Browser capability is not connected to this Agent session')
  }
  return { hostUrl: value.hostUrl.replace(/\/$/, ''), sessionId: value.sessionId, controlToken: value.controlToken }
}

async function invoke(path: string, action: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const binding = await capability(path)
  const endpoint = `${binding.hostUrl}/v1/browser/sessions/${encodeURIComponent(binding.sessionId)}/actions`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${binding.controlToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, actionId: randomUUID(), sessionId: binding.sessionId, actor: 'agent', action }),
    signal,
  })
  const payload = await response.json().catch(() => null) as { result?: Record<string, unknown>; error?: { message?: string } } | null
  if (!response.ok || !payload?.result) throw new Error(payload?.error?.message ?? `Browser Host returned ${response.status}`)
  if (payload.result.ok !== true) throw new Error((payload.result.error as { message?: string } | undefined)?.message ?? 'Browser action failed')
  return payload.result
}

function json(response: ServerResponse, id: JsonRpcId, result?: unknown, error?: { code: number; message: string }): void {
  response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }))
}

/** Streamable-HTTP MCP adapter over the existing session-scoped Browser Host.
 * Codex consumes this through its native mcp_servers configuration; Pi keeps
 * consuming the same capability through its native extension contract. */
export async function handleBrowserMcpRequest(request: IncomingMessage, response: ServerResponse, capabilityFile: string): Promise<void> {
  const body = await readBody(request)
  const id = (typeof body.id === 'string' || typeof body.id === 'number' || body.id === null) ? body.id : null
  const method = typeof body.method === 'string' ? body.method : ''
  if (method === 'initialize') {
    json(response, id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'openlink-browser', version: '1.0.0' },
      instructions: 'Browser tools bound to the current OpenLink session. Use browser_open/read before interaction and never invent a page id.',
    })
    return
  }
  if (method === 'notifications/initialized') {
    response.writeHead(202).end()
    return
  }
  if (method === 'ping') { json(response, id, {}); return }
  if (method === 'tools/list') {
    json(response, id, { tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, idempotentHint: tool.readOnly, openWorldHint: true },
    })) })
    return
  }
  if (method !== 'tools/call') { json(response, id, undefined, { code: -32601, message: `Method not found: ${method}` }); return }
  const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params as Record<string, unknown> : {}
  const tool = TOOLS.find((candidate) => candidate.name === params.name)
  if (!tool) { json(response, id, undefined, { code: -32602, message: `Unknown tool: ${String(params.name)}` }); return }
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {}
  try {
    const result = await invoke(capabilityFile, tool.action(args), AbortSignal.timeout(30_000))
    const image = result.image as { mimeType?: unknown; data?: unknown } | undefined
    const content = tool.name === 'browser_screenshot' && typeof image?.mimeType === 'string' && typeof image.data === 'string'
      ? [{ type: 'image', mimeType: image.mimeType, data: image.data }]
      : [{ type: 'text', text: tool.name === 'browser_read' ? String(result.snapshot ?? JSON.stringify(result)) : JSON.stringify(result) }]
    json(response, id, { content, isError: false })
  } catch (error) {
    json(response, id, { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true })
  }
}
