import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { CodexAppServerRuntime } from '../../services/agent-worker/dist/codex-runtime.js'

test('MCP slash resources expose native enabled and authentication status without prompt text', async () => {
  const runtime = new CodexAppServerRuntime({
    workspaceRoot: '/workspace', sessionRoot: '/session', codexHome: '/codex',
    codexBin: 'unused', accessMode: 'restricted', providerId: 'test',
    providerBaseUrl: 'https://provider.test/v1', model: 'test/model',
  })
  runtime.threadId = 'thread-1'
  runtime.start = async () => {}
  runtime.request = async (method, params) => {
    assert.equal(method, 'mcpServerStatus/list')
    assert.deepEqual(params, { limit: 100, detail: 'toolsAndAuthOnly', threadId: 'thread-1' })
    return { data: [
      { name: 'openlink_supabase', runtimeStatus: 'connected', authStatus: 'bearerToken' },
      { name: 'disabled_server', runtimeStatus: 'disabled', authStatus: 'notLoggedIn' },
    ] }
  }

  const result = await runtime.resources({ scope: 'command', command: 'mcp', query: '' })
  assert.deepEqual(result.items, [
    { id: 'mcp:openlink_supabase', type: 'mcp', label: 'openlink_supabase', description: 'Enabled', secondaryContent: 'Authenticated (API key)', insertText: '', group: 'MCP', command: 'mcp' },
    { id: 'mcp:disabled_server', type: 'mcp', label: 'disabled_server', description: 'Disabled', secondaryContent: 'Not authenticated', insertText: '', group: 'MCP', command: 'mcp' },
  ])
})

test('the MCP submenu distinguishes loading, empty and failed inventory states', () => {
  const workspace = readFileSync(new URL('../../components/chat-workspace.tsx', import.meta.url), 'utf8')
  assert.match(workspace, /promptResourceRequest\?\.command === 'mcp' \? ' MCP 状态'/)
  assert.match(workspace, /promptResourceRequest\?\.command === 'plugins' \? '没有已启用 Plugins'/)
  assert.match(workspace, /setPromptResourcesLoading\(false\)\s+setPromptResourcesError\(true\)/)
})
