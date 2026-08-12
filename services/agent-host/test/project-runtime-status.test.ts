import assert from 'node:assert/strict'
import test from 'node:test'
import { SupabaseProjectRuntimeStatusWriter, createSupabaseProjectRuntimeStatusWriter } from '../src/project-runtime-status.js'

test('writes project runtime status through Supabase service-role REST upsert', async () => {
  let request: { url: string; init?: RequestInit } | undefined
  const writer = new SupabaseProjectRuntimeStatusWriter({
    url: 'https://supabase.example.test/',
    serviceRoleKey: 'service-role-secret',
    fetch: async (url, init) => {
      request = { url: String(url), init }
      return new Response(null, { status: 201 })
    },
  })

  await writer.update({
    projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c',
    backend: 'podman-machine',
    machineName: 'olp-project',
    workspacePath: '/home/core/openlink/projects/project/workspace',
    status: 'ready',
    opensandboxEndpoint: 'http://127.0.0.1:51127',
    browserHostEndpoint: 'http://127.0.0.1:52127',
    diskMode: 'thick',
    lastError: null,
  })

  assert.equal(request?.url, 'https://supabase.example.test/rest/v1/project_runtimes?on_conflict=project_id')
  assert.equal(request?.init?.method, 'POST')
  assert.equal((request?.init?.headers as Record<string, string>).Authorization, 'Bearer service-role-secret')
  const body = JSON.parse(String(request?.init?.body)) as Record<string, unknown>
  assert.equal(body.project_id, '2c51ca26-3cd0-4cb4-896d-2061de06098c')
  assert.equal(body.status, 'ready')
  assert.equal(body.last_error, null)
  assert.equal(body.disk_mode, 'thick')
  assert.equal((request?.init?.headers as Record<string, string>)['Content-Profile'], 'openlink')
  assert.equal(body.service_role_key, undefined)
})

test('skips optional Supabase writer when service-role credentials are absent', async () => {
  assert.equal(createSupabaseProjectRuntimeStatusWriter({ OPENLINK_SUPABASE_URL: 'https://supabase.example.test' }), undefined)
})
