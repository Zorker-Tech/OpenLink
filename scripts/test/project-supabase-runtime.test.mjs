import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareRelease,
  containerUsesImage,
  dependencyOrder,
  generateProjectSupabaseSecrets,
  interpolate,
  parseEnvTemplate,
  serviceCreateArgs,
  upgradeGates,
  validateRuntimeSpec,
} from '../../services/agent-host/project-supabase-runtime.mjs'

const projectId = '11111111-2222-4333-8444-555555555555'

test('generates independent complete project secrets without example placeholders', () => {
  const left = generateProjectSupabaseSecrets(projectId, 1_700_000_000)
  const right = generateProjectSupabaseSecrets(projectId, 1_700_000_000)
  for (const key of ['POSTGRES_PASSWORD', 'JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'JWT_KEYS', 'JWT_JWKS', 'DASHBOARD_PASSWORD', 'SECRET_KEY_BASE', 'REALTIME_DB_ENC_KEY', 'VAULT_ENC_KEY', 'PG_META_CRYPTO_KEY']) assert.ok(left[key], key)
  assert.notEqual(left.JWT_SECRET, right.JWT_SECRET)
  assert.notEqual(left.POSTGRES_PASSWORD, right.POSTGRES_PASSWORD)
  assert.match(left.SUPABASE_PUBLISHABLE_KEY, /^sb_publishable_/)
  assert.match(left.SUPABASE_SECRET_KEY, /^sb_secret_/)
  assert.equal(left.REALTIME_DB_ENC_KEY.length, 16)
  assert.equal(left.VAULT_ENC_KEY.length, 32)
  assert.equal(left.ANON_KEY.split('.').length, 3)
  assert.equal(JSON.parse(left.JWT_KEYS).length, 2)
  assert.equal(JSON.parse(left.JWT_JWKS).keys[0].d, undefined)
})

test('parses environment templates and handles recursive Compose defaults without shell evaluation', () => {
  const environment = parseEnvTemplate("A=one\nB=\"two words\"\n# ignored\nEMPTY=\n")
  assert.deepEqual(environment, { A: 'one', B: 'two words', EMPTY: '' })
  assert.equal(interpolate('${A}:${MISSING:-${B}}:${EMPTY:-fallback}', environment), 'one:two words:fallback')
  assert.throws(() => interpolate('${REQUIRED}', environment), /required environment variable/)
  assert.throws(() => interpolate('${A?error}', environment), /unsupported environment expression/)
})

test('rejects unreviewed Compose fields and dependency cycles', () => {
  const valid = { schemaVersion: 1, compose: { services: { db: { image: 'supabase/postgres:v1' } }, volumes: {} } }
  assert.equal(validateRuntimeSpec(valid), valid)
  assert.throws(() => validateRuntimeSpec({ schemaVersion: 1, compose: { services: { db: { image: 'supabase/postgres:v1', privileged: true } } } }), /unsupported field privileged/)
  assert.deepEqual(dependencyOrder({ db: {}, auth: { depends_on: { db: {} } }, api: { depends_on: { auth: {} } } }), ['db', 'auth', 'api'])
  assert.throws(() => dependencyOrder({ a: { depends_on: { b: {} } }, b: { depends_on: { a: {} } } }), /dependency cycle/)
})

test('matches resident Supabase containers by immutable image id instead of canonicalized image name', () => {
  const id = 'a'.repeat(64)
  assert.equal(containerUsesImage({ Image: id, ImageName: 'docker.io/supabase/postgres:17.6.1.136' }, `sha256:${id}`), true)
  assert.equal(containerUsesImage({ Image: 'b'.repeat(64), ImageName: 'supabase/postgres:17.6.1.136' }, `sha256:${id}`), false)
  assert.equal(containerUsesImage({ ImageName: 'docker.io/supabase/postgres:17.6.1.136' }, `sha256:${id}`), false)
})

test('builds fixed Podman argv with loopback publications and mapped durable paths', () => {
  const environment = { TOKEN: 'secret' }
  const common = {
    projectId,
    stateRoot: '/var/lib/openlink/project-supabase',
    workspace: '/workspace',
    gatewayPort: 54321,
    databasePort: 54322,
    poolerPort: 54323,
    release: 'self-hosted/v0.8.0',
    configHash: 'a'.repeat(64),
  }
  const args = serviceCreateArgs('api-gw', {
    image: 'envoyproxy/envoy:v1.39.0',
    restart: 'unless-stopped',
    environment: { TOKEN: '${TOKEN}' },
    networks: { default: { aliases: ['envoy', 'kong'] } },
    ports: ['${API_GW_HTTP_PORT}:8000'],
    volumes: [{ type: 'bind', source: 'configuration/volumes/api/envoy/envoy.yaml', target: '/etc/envoy/envoy.yaml', read_only: true }],
    healthcheck: { test: ['CMD-SHELL', 'test -f /etc/envoy/envoy.yaml'], interval: '10s', timeout: '5s', retries: 3 },
  }, environment, common)
  assert.deepEqual(args.slice(0, 5), ['create', '--name', 'openlink-project-supabase-api-gw', '--network', 'openlink-project-supabase'])
  assert.ok(args.includes('TOKEN=secret'))
  assert.ok(args.includes('127.0.0.1:54321:8000/tcp'))
  assert.ok(args.includes('/var/lib/openlink/project-supabase/configuration/volumes/api/envoy/envoy.yaml:/etc/envoy/envoy.yaml:ro'))
  assert.ok(args.includes('io.openlink.project-supabase=true'))
  assert.ok(args.includes('label=disable'))
  assert.ok(!args.includes('--privileged'))
})

test('controller source redacts Podman argv failures before they cross the service boundary', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../../services/agent-host/project-supabase-runtime.mjs', import.meta.url), 'utf8')
  assert.match(source, /Never surface the child[\s\S]*fail\(`Podman \$\{args\[0\]/)
  assert.doesNotMatch(source, /throw error;?\s*\}\s*\n\s*}\s*\n\s*function containerName/)
})

test('compareRelease orders self-hosted semver tags numerically and rejects malformed versions', () => {
  assert.equal(compareRelease('self-hosted/v1.2.3', 'self-hosted/v1.2.3'), 0)
  assert.ok(compareRelease('self-hosted/v1.2.3', 'self-hosted/v1.2.4') < 0)
  assert.ok(compareRelease('self-hosted/v1.3.0', 'self-hosted/v1.2.99') > 0)
  assert.ok(compareRelease('self-hosted/v2.0.0', 'self-hosted/v1.99.99') > 0)
  assert.throws(() => compareRelease('1.2.3', 'self-hosted/v1.2.3'), /release version is invalid/)
  assert.throws(() => compareRelease('self-hosted/v1.2', 'self-hosted/v1.2.3'), /release version is invalid/)
})

test('upgradeGates returns only the migration gates that must run between current and target', () => {
  const targetLock = {
    release: { tag: 'self-hosted/v1.4.0', commit: 'abc' },
    upgradeGates: [
      { version: '1.2.0', description: 'auth migration' },
      { version: '1.3.0', description: 'storage migration' },
      { version: '1.4.0', description: 'realtime migration' },
      { version: '1.5.0', description: 'future migration, not yet target' },
    ],
  }
  // current 1.1.0 -> target 1.4.0: gates at 1.2.0, 1.3.0, 1.4.0 apply (those
  // strictly newer than current and not newer than target).
  const gates = upgradeGates('self-hosted/v1.1.0', targetLock)
  assert.deepEqual(gates.map((gate) => gate.version), ['1.2.0', '1.3.0', '1.4.0'])
})

test('upgradeGates skips gates already applied to the current release', () => {
  const targetLock = {
    release: { tag: 'self-hosted/v1.4.0', commit: 'abc' },
    upgradeGates: [{ version: '1.2.0' }, { version: '1.3.0' }, { version: '1.4.0' }],
  }
  // current 1.3.0 -> target 1.4.0: only the 1.4.0 gate remains; 1.2.0 and
  // 1.3.0 are already part of the running release.
  const gates = upgradeGates('self-hosted/v1.3.0', targetLock)
  assert.deepEqual(gates.map((gate) => gate.version), ['1.4.0'])
})

test('upgradeGates refuses downgrade and same-version re-upgrades', () => {
  const targetLock = {
    release: { tag: 'self-hosted/v1.4.0', commit: 'abc' },
    upgradeGates: [{ version: '1.4.0' }],
  }
  assert.throws(() => upgradeGates('self-hosted/v1.4.0', targetLock), /must be newer than/)
  assert.throws(() => upgradeGates('self-hosted/v1.5.0', targetLock), /must be newer than/)
})
