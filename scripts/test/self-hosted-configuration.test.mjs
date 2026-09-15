import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createProductionConfiguration, updateProductionProjectRuntime } from '../../deploy/self-hosted/runtime/configuration.mjs'
import { readEnvironmentFile } from '../../deploy/self-hosted/runtime/preflight.mjs'
import { validateProductionEnvironment } from '../../deploy/self-hosted/runtime/production-runtime.mjs'

test('configure creates separate protected secrets with no development defaults', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-configure-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const releaseRoot = join(root, 'release')
  const template = join(releaseRoot, 'orchestration/backend/docker/.env.example')
  await mkdir(join(template, '..'), { recursive: true })
  await writeFile(template, 'POSTGRES_PASSWORD=insecure\nJWT_SECRET=insecure\nANON_KEY=insecure\nSERVICE_ROLE_KEY=insecure\nDASHBOARD_PASSWORD=insecure\n')
  const configPath = join(root, 'config/openlink.env')
  const result = await createProductionConfiguration({ releaseRoot, configPath, stateRoot: join(root, 'state'), appUrl: 'https://openlink.example.test' })
  const config = await readEnvironmentFile(result.configPath)
  const secrets = await readEnvironmentFile(result.secretsPath, { secrets: true })
  validateProductionEnvironment({ ...config, ...secrets })
  assert.equal(config.OPENLINK_APP_URL, 'https://openlink.example.test')
  assert.equal(config.OPENLINK_DEPLOYMENT_PROFILE, 'standard')
  assert.equal(config.OPENLINK_DEPLOYMENT_PROFILE_REVISION, 'standard/v1')
  assert.equal(config.OPENLINK_PROJECT_RUNTIME, 'vm')
  assert.equal(config.OPENLINK_PROJECT_ISOLATION, 'vm')
  assert.equal(config.OPENLINK_KNOWLEDGE_ENABLED, '1')
  assert.equal(config.OPENLINK_ZERO_ENABLED, '1')
  assert.equal(config.OPENLINK_MINIMUM_LOGICAL_CPUS, '8')
  assert.equal(config.OPENLINK_EDGE_ADDRESS, 'openlink.example.test')
  assert.equal(secrets.POSTGRES_PORT, '54384')
  assert.equal(Object.keys(config).filter((key) => !key.endsWith('_FILE')).some((key) => /TOKEN|SECRET|PASSWORD/.test(key)), false)
  assert.notEqual(secrets.POSTGRES_PASSWORD, 'insecure')
  assert.match(secrets.ANON_KEY, /^[^.]+\.[^.]+\.[^.]+$/)
  assert.equal(Buffer.from(secrets.OPENLINK_PROVIDER_SECRET_KEY, 'base64url').length, 32)
  assert.equal((await lstat(result.secretsPath)).mode & 0o077, 0)
  await assert.rejects(createProductionConfiguration({ releaseRoot, configPath, stateRoot: join(root, 'state'), appUrl: 'https://openlink.example.test' }), /exist/i)
})

test('configure persists deployment profile and Project backend independently', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-configure-profile-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const template = join(root, 'release/orchestration/backend/docker/.env.example')
  await mkdir(join(template, '..'), { recursive: true })
  await writeFile(template, 'POSTGRES_PASSWORD=insecure\n')
  const result = await createProductionConfiguration({
    releaseRoot: join(root, 'release'),
    configPath: join(root, 'config.env'),
    stateRoot: join(root, 'state'),
    appUrl: 'https://openlink.example.test',
    deploymentProfile: 'dense',
    projectRuntime: 'container',
  })
  const config = await readEnvironmentFile(result.configPath)
  assert.equal(config.OPENLINK_DEPLOYMENT_PROFILE, 'dense')
  assert.equal(config.OPENLINK_DEPLOYMENT_PROFILE_REVISION, 'dense/v1')
  assert.equal(config.OPENLINK_PROJECT_RUNTIME, 'container')
  assert.equal(config.OPENLINK_PROJECT_ISOLATION, 'container')
  assert.equal(config.OPENLINK_KNOWLEDGE_ENABLED, '1')
  assert.equal(config.OPENLINK_PROJECT_VM_CPUS, '2')
  assert.equal(config.OPENLINK_PROJECT_VM_MEMORY_MB, '6144')
  assert.equal(config.OPENLINK_MINIMUM_LOGICAL_CPUS, '16')
  assert.equal(config.OPENLINK_MINIMUM_MEMORY_BYTES, String(64 * 1024 ** 3))
  assert.equal(config.OPENLINK_MINIMUM_FREE_BYTES, String(500 * 1024 ** 3))
})

test('configure makes Core knowledge omission explicit without forcing Container', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-configure-core-vm-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const template = join(root, 'release/orchestration/backend/docker/.env.example')
  await mkdir(join(template, '..'), { recursive: true })
  await writeFile(template, 'POSTGRES_PASSWORD=insecure\n')
  const result = await createProductionConfiguration({
    releaseRoot: join(root, 'release'),
    configPath: join(root, 'config.env'),
    stateRoot: join(root, 'state'),
    appUrl: 'https://openlink.example.test',
    deploymentProfile: 'core',
    projectRuntime: 'vm',
  })
  const config = await readEnvironmentFile(result.configPath)
  assert.equal(config.OPENLINK_DEPLOYMENT_PROFILE, 'core')
  assert.equal(config.OPENLINK_PROJECT_RUNTIME, 'vm')
  assert.equal(config.OPENLINK_KNOWLEDGE_ENABLED, '0')
  assert.equal(config.OPENLINK_ZERO_ENABLED, '0')
})

test('configure rejects plaintext production origins unless explicitly opted in', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-configure-http-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const template = join(root, 'release/orchestration/backend/docker/.env.example')
  await mkdir(join(template, '..'), { recursive: true })
  await writeFile(template, 'POSTGRES_PASSWORD=insecure\n')
  await assert.rejects(createProductionConfiguration({ releaseRoot: join(root, 'release'), configPath: join(root, 'config.env'), stateRoot: join(root, 'state'), appUrl: 'http://127.0.0.1:3000' }), /https/i)
})

test('runtime selection updates only the persisted backend and isolation class', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-configure-runtime-update-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const template = join(root, 'release/orchestration/backend/docker/.env.example')
  await mkdir(join(template, '..'), { recursive: true })
  await writeFile(template, 'POSTGRES_PASSWORD=insecure\n')
  const created = await createProductionConfiguration({ releaseRoot: join(root, 'release'), configPath: join(root, 'config.env'), stateRoot: join(root, 'state'), appUrl: 'https://openlink.example.test', deploymentProfile: 'dense', projectRuntime: 'vm' })
  const changed = await updateProductionProjectRuntime(created.configPath, 'container')
  assert.deepEqual({ previousRuntime: changed.previousRuntime, runtime: changed.runtime, changed: changed.changed }, { previousRuntime: 'vm', runtime: 'container', changed: true })
  const config = await readEnvironmentFile(created.configPath)
  assert.equal(config.OPENLINK_DEPLOYMENT_PROFILE, 'dense')
  assert.equal(config.OPENLINK_PROJECT_RUNTIME, 'container')
  assert.equal(config.OPENLINK_PROJECT_ISOLATION, 'container')
  assert.equal((await lstat(created.configPath)).mode & 0o777, 0o640)
})

test('runtime selection refuses to orphan persisted Projects without migration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-configure-runtime-migration-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const template = join(root, 'release/orchestration/backend/docker/.env.example')
  await mkdir(join(template, '..'), { recursive: true })
  await writeFile(template, 'POSTGRES_PASSWORD=insecure\n')
  const created = await createProductionConfiguration({ releaseRoot: join(root, 'release'), configPath: join(root, 'config.env'), stateRoot: join(root, 'state'), appUrl: 'https://openlink.example.test', projectRuntime: 'vm' })
  await mkdir(join(root, 'state/project-vms/projects/123e4567-e89b-42d3-a456-426614174000'), { recursive: true })
  await assert.rejects(updateProductionProjectRuntime(created.configPath, 'container'), /persisted Projects exist/i)
  assert.equal((await readEnvironmentFile(created.configPath)).OPENLINK_PROJECT_RUNTIME, 'vm')
})
