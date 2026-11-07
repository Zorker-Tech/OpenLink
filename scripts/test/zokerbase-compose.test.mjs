import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../', import.meta.url)

test('local Supavisor has a stable resolvable Erlang node hostname', async () => {
  const source = await readFile(new URL('backend/docker/docker-compose.zokerbase.yml', root), 'utf8')
  const supavisor = source.match(/(?:^|\n)  supavisor:\n([\s\S]*?)(?=\n  [A-Za-z0-9_-]+:\n|\nvolumes:|$)/)?.[1]
  assert.ok(supavisor, 'missing Supavisor service override')
  assert.match(supavisor, /^    hostname: zokerbase-pooler$/m)
  assert.match(supavisor, /Erlang distribution uses its container hostname/)
})
