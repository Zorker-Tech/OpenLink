import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createProductionConfiguration } from '../../deploy/self-hosted/runtime/configuration.mjs'
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
  assert.equal(Object.keys(config).filter((key) => !key.endsWith('_FILE')).some((key) => /TOKEN|SECRET|PASSWORD/.test(key)), false)
  assert.notEqual(secrets.POSTGRES_PASSWORD, 'insecure')
  assert.match(secrets.ANON_KEY, /^[^.]+\.[^.]+\.[^.]+$/)
  assert.equal((await lstat(result.secretsPath)).mode & 0o077, 0)
  await assert.rejects(createProductionConfiguration({ releaseRoot, configPath, stateRoot: join(root, 'state'), appUrl: 'https://openlink.example.test' }), /exist/i)
})

test('configure rejects plaintext production origins unless explicitly opted in', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-configure-http-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const template = join(root, 'release/orchestration/backend/docker/.env.example')
  await mkdir(join(template, '..'), { recursive: true })
  await writeFile(template, 'POSTGRES_PASSWORD=insecure\n')
  await assert.rejects(createProductionConfiguration({ releaseRoot: join(root, 'release'), configPath: join(root, 'config.env'), stateRoot: join(root, 'state'), appUrl: 'http://127.0.0.1:3000' }), /https/i)
})
