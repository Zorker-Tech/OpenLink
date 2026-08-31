import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  PROJECT_SUPABASE_REQUIRED_SERVICES,
  compareSelfHostedTags,
  hashConfigurationTree,
  latestSelfHostedTag,
  normalizeUpgradeGates,
  validateProjectSupabaseLock,
} from '../lib/project-supabase-lock.mjs'

const digest = (character) => `sha256:${character.repeat(64)}`

function validLock() {
  return {
    schemaVersion: 1,
    release: {
      tag: 'self-hosted/v0.8.0',
      version: '0.8.0',
      tagObject: 'a'.repeat(40),
      commit: 'b'.repeat(40),
      repository: 'https://github.com/supabase/supabase.git',
    },
    configuration: {
      root: 'docker',
      treeSha256: 'c'.repeat(64),
      upgradesSha256: 'd'.repeat(64),
      runtimeSpecSha256: '1'.repeat(64),
    },
    services: PROJECT_SUPABASE_REQUIRED_SERVICES.map((name, index) => ({
      name,
      image: `example.invalid/supabase/${name}:v${index + 1}`,
      aliases: name === 'api-gw' ? ['envoy', 'kong'] : [],
      platforms: {
        amd64: { digest: digest('e'), size: 100 + index },
        arm64: { digest: digest('f'), size: 200 + index },
      },
    })),
    upgradeGates: [{
      version: '0.8.0',
      breaking: true,
      gate: null,
      migrationGuideUrl: 'https://example.invalid/migrate',
      requires: ['Switch the API gateway.'],
    }],
  }
}

test('selects the highest stable self-hosted semver without lexical sorting errors', () => {
  assert.equal(latestSelfHostedTag(['self-hosted/v0.9.9', 'self-hosted/v0.10.0', 'self-hosted/v0.8.0']), 'self-hosted/v0.10.0')
  assert.ok(compareSelfHostedTags('self-hosted/v1.0.0', 'self-hosted/v0.99.99') > 0)
  assert.throws(() => latestSelfHostedTag(['self-hosted/v0.8.0-rc.1']), /stable/)
})

test('accepts a complete immutable multi-architecture release lock', () => {
  assert.equal(validateProjectSupabaseLock(validLock()).release.version, '0.8.0')
})

test('rejects an incomplete default service set and floating image references', () => {
  const missing = validLock()
  missing.services.pop()
  assert.throws(() => validateProjectSupabaseLock(missing), /exactly/)
  const floating = validLock()
  floating.services[0].image = 'supabase/studio@sha256:' + 'a'.repeat(64)
  assert.throws(() => validateProjectSupabaseLock(floating), /tagged OCI reference/)
})

test('rejects missing platform digests and alias collisions', () => {
  const missingPlatform = validLock()
  delete missingPlatform.services[0].platforms.arm64
  assert.throws(() => validateProjectSupabaseLock(missingPlatform), /exactly/)
  const duplicateAlias = validLock()
  duplicateAlias.services[1].aliases.push('envoy')
  assert.throws(() => validateProjectSupabaseLock(duplicateAlias), /Duplicate Supabase network alias/)
})

test('keeps annotated tag object and peeled commit as separate authorities', () => {
  const lock = validLock()
  lock.release.commit = lock.release.tagObject
  assert.throws(() => validateProjectSupabaseLock(lock), /separately/)
})

test('configuration tree hash is deterministic across root directories and changes with content', async () => {
  const left = await mkdtemp(resolve(tmpdir(), 'project-supabase-left-'))
  const right = await mkdtemp(resolve(tmpdir(), 'project-supabase-right-'))
  for (const root of [left, right]) {
    await mkdir(resolve(root, 'volumes/db'), { recursive: true })
    await writeFile(resolve(root, 'docker-compose.yml'), 'services: {}\n')
    await writeFile(resolve(root, 'volumes/db/init.sql'), 'select 1;\n')
    await symlink('docker-compose.yml', resolve(root, 'compose-link'))
  }
  assert.equal(await hashConfigurationTree(left), await hashConfigurationTree(right))
  await writeFile(resolve(right, 'volumes/db/init.sql'), 'select 2;\n')
  assert.notEqual(await hashConfigurationTree(left), await hashConfigurationTree(right))
})

test('configuration tree identity is independent of host file mode representation', async () => {
  const left = await mkdtemp(resolve(tmpdir(), 'project-supabase-mode-left-'))
  const right = await mkdtemp(resolve(tmpdir(), 'project-supabase-mode-right-'))
  await writeFile(resolve(left, 'entrypoint.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await writeFile(resolve(right, 'entrypoint.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o644 })
  assert.equal(await hashConfigurationTree(left), await hashConfigurationTree(right))
})

test('normalizes and semantically orders upstream upgrade gates', () => {
  assert.deepEqual(normalizeUpgradeGates({
    _schema: {},
    '0.10.0': { breaking: false, gate: null, migration_guide_url: null, requires: [] },
    '0.8.0': { breaking: true, gate: 'utils/migrate.sh', migration_guide_url: 'https://example.invalid', requires: ['Review'] },
  }).map((gate) => gate.version), ['0.8.0', '0.10.0'])
})
