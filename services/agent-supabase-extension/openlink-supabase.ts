import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent'

/**
 * OpenLink Supabase MCP bridge for Pi sessions.
 *
 * Connects to the project-scoped MCP endpoint hosted by the Agent Host
 * (`/v1/projects/:id/supabase/mcp`, Streamable HTTP + JSON responses) and
 * registers every MCP tool it advertises as a native Pi tool. The capability
 * token is scoped to this project and short-lived; it never carries Supabase
 * secrets, and management operations stay read-only inside the VM.
 */

interface McpToolDefinition {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required by the OpenLink Supabase extension`)
  return value
}

async function mcpCall(url: string, token: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const sessionId = process.env.OPENLINK_SUPABASE_MCP_SESSION_ID?.trim()
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(sessionId ? { 'x-openlink-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), ...body }),
    signal,
  })
  const payload = await response.json().catch(() => null) as { result?: Record<string, unknown>; error?: { message?: string } } | null
  if (!response.ok || !payload || payload.error) {
    throw new Error(payload?.error?.message ?? `Supabase MCP call failed (${response.status})`)
  }
  return payload.result ?? {}
}

export default function openLinkSupabaseExtension(pi: ExtensionAPI) {
  const url = required('OPENLINK_SUPABASE_MCP_URL')
  const token = required('OPENLINK_SUPABASE_MCP_TOKEN')

  void (async () => {
    await mcpCall(url, token, { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'openlink-pi', version: '1.0.0' } } })
    const listed = await mcpCall(url, token, { method: 'tools/list', params: {} })
    const tools = Array.isArray(listed.tools) ? listed.tools as McpToolDefinition[] : []

    for (const tool of tools) {
      if (typeof tool.name !== 'string' || !tool.name) continue
      const schema = (tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} }) as Parameters<typeof defineTool>[0]['parameters']
      pi.registerTool(defineTool({
        name: tool.name,
        label: tool.name.replace(/^supabase_/, 'Supabase ').replace(/_/g, ' '),
        description: tool.description ?? `Supabase management tool ${tool.name}`,
        promptSnippet: tool.description ?? tool.name,
        parameters: schema as never,
        async execute(_id, params, signal) {
          const result = await mcpCall(url, token, { method: 'tools/call', params: { name: tool.name, arguments: params ?? {} } }, signal)
          const content = Array.isArray(result.content) ? result.content : []
          const text = content.map((item) => typeof item === 'object' && item !== null && 'text' in item ? String((item as { text?: unknown }).text) : '').filter(Boolean).join('\n')
          return { content: [{ type: 'text' as const, text: text || '{}' }], details: result }
        },
      }))
    }
  })().catch((error) => {
    console.error(`OpenLink Supabase extension failed to register MCP tools: ${error instanceof Error ? error.message : String(error)}`)
  })
}
