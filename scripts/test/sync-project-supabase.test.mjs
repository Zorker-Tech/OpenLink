import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeRuntimeSpec, parseComposeServices, parseLsRemoteTags, platformDescriptors } from '../sync-project-supabase.mjs'
import { PROJECT_SUPABASE_REQUIRED_SERVICES } from '../lib/project-supabase-lock.mjs'

test('parses annotated self-hosted tags and peeled commits', () => {
  const refs = parseLsRemoteTags([
    `${'a'.repeat(40)}\trefs/tags/self-hosted/v0.8.0`,
    `${'b'.repeat(40)}\trefs/tags/self-hosted/v0.8.0^{}`,
    `${'c'.repeat(40)}\trefs/tags/unrelated/v1.0.0`,
  ].join('\n'))
  assert.deepEqual(refs.get('self-hosted/v0.8.0'), { tagObject: 'a'.repeat(40), commit: 'b'.repeat(40) })
  assert.equal(refs.size, 1)
})

test('extracts exactly the reviewed default service contract', () => {
  const services = Object.fromEntries(PROJECT_SUPABASE_REQUIRED_SERVICES.map((name) => [name, {
    image: `registry.invalid/${name}:v1`,
    networks: name === 'api-gw' ? { default: { aliases: ['envoy', 'kong', 'api-gw'] } } : {},
  }]))
  const contract = parseComposeServices({ services })
  assert.equal(contract.length, PROJECT_SUPABASE_REQUIRED_SERVICES.length)
  assert.deepEqual(contract.find((service) => service.name === 'api-gw').aliases, ['envoy', 'kong'])
  services.analytics = { image: 'registry.invalid/analytics:v1' }
  assert.throws(() => parseComposeServices({ services }), /unreviewed services/)
})

test('selects exact architecture manifests and rejects attestation descriptors', () => {
  const raw = {
    manifests: [
      { digest: `sha256:${'a'.repeat(64)}`, size: 101, platform: { os: 'linux', architecture: 'amd64' } },
      { digest: `sha256:${'b'.repeat(64)}`, size: 202, platform: { os: 'linux', architecture: 'arm64' } },
      { digest: `sha256:${'c'.repeat(64)}`, size: 303, platform: { os: 'unknown', architecture: 'unknown' } },
    ],
  }
  assert.deepEqual(platformDescriptors(raw, 'example:v1'), {
    amd64: { digest: `sha256:${'a'.repeat(64)}`, size: 101 },
    arm64: { digest: `sha256:${'b'.repeat(64)}`, size: 202 },
  })
  raw.manifests.push({ digest: `sha256:${'d'.repeat(64)}`, size: 404, platform: { os: 'linux', architecture: 'arm64' } })
  assert.throws(() => platformDescriptors(raw, 'example:v1'), /exactly one linux\/arm64/)
})

test('normalizes runtime bind mounts under the immutable configuration root', () => {
  const spec = normalizeRuntimeSpec({
    name: 'supabase',
    services: {
      db: {
        container_name: 'supabase-db',
        image: 'supabase/postgres:v1',
        volumes: [{ type: 'bind', source: '/release/docker/volumes/db/init.sql', target: '/init.sql', bind: { create_host_path: true } }],
      },
      auth: { environment: {} },
      realtime: { environment: {} },
      storage: { environment: {} },
      functions: { environment: {} },
    },
    volumes: {},
  }, '/release/docker')
  assert.equal(spec.compose.name, undefined)
  assert.equal(spec.compose.services.db.container_name, undefined)
  assert.equal(spec.compose.services.db.volumes[0].source, 'configuration/volumes/db/init.sql')
  assert.equal(spec.compose.services.db.volumes[0].bind.create_host_path, undefined)
  assert.equal(spec.compose.services.auth.environment.GOTRUE_JWT_KEYS, '${JWT_KEYS}')
  assert.throws(() => normalizeRuntimeSpec({ services: { db: { volumes: [{ type: 'bind', source: '/etc/passwd', target: '/escape' }] }, auth: { environment: {} }, realtime: { environment: {} }, storage: { environment: {} }, functions: { environment: {} } } }, '/release/docker'), /escapes/)
})

test('preserves runtime secret expressions instead of compiling example values', () => {
  const spec = normalizeRuntimeSpec({
    services: {
      db: { image: 'supabase/postgres:v1', environment: { POSTGRES_PASSWORD: '${POSTGRES_PASSWORD}', JWT_SECRET: '${JWT_SECRET}' } },
      auth: { image: 'supabase/gotrue:v1', environment: { GOTRUE_DB_DATABASE_URL: 'postgres://postgres:${POSTGRES_PASSWORD}@db:5432/postgres' } },
      realtime: { image: 'supabase/realtime:v1', environment: {} },
      storage: { image: 'supabase/storage:v1', environment: {} },
      functions: { image: 'supabase/functions:v1', environment: {} },
      supavisor: { image: 'supabase/supavisor:v1', environment: {}, command: ['/bin/sh', '-c', 'eval "$$(cat /etc/pooler.exs)"'] },
    },
    volumes: {},
  }, '/release/docker')
  assert.equal(spec.compose.services.db.environment.POSTGRES_PASSWORD, '${POSTGRES_PASSWORD}')
  assert.equal(spec.compose.services.db.environment.JWT_SECRET, '${JWT_SECRET}')
  assert.match(spec.compose.services.auth.environment.GOTRUE_DB_DATABASE_URL, /\$\{POSTGRES_PASSWORD\}/)
  assert.equal(spec.compose.services.supavisor.command[2], 'eval "$(cat /etc/pooler.exs)"')
})
