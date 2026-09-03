import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { assertRollbackCompatible, assertUpgradeCompatible, executeRollbackTransaction, executeUpgradeTransaction } from '../../deploy/self-hosted/runtime/upgrade.mjs'

const manifest = (releaseId, releaseSequence, schema = 1, minimum = schema, maximum = schema) => ({ releaseId, releaseSequence, compatibility: { stateSchema: schema, minimumStateSchema: minimum, maximumStateSchema: maximum } })

test('upgrade transaction commits only after stop, backup, stage, activation, start and health', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'openlink-upgrade-'))
  t.after(async () => (await import('node:fs/promises')).rm(stateRoot, { recursive: true, force: true }))
  const events = []
  const transaction = await executeUpgradeTransaction({
    transactionId: 'upgrade-1', stateRoot,
    currentManifest: manifest('release-a', 1), candidateManifest: manifest('release-b', 2),
    stopService: async () => events.push('stop'), backup: async () => { events.push('backup'); return { id: 'backup-1' } },
    stage: async () => events.push('stage'), activate: async (id) => events.push(`activate:${id}`),
    startService: async () => events.push('start'), healthCheck: async (id) => events.push(`health:${id}`),
  })
  assert.deepEqual(events, ['stop', 'backup', 'stage', 'activate:release-b', 'start', 'health:release-b'])
  assert.equal(transaction.phase, 'committed')
  assert.equal(JSON.parse(await readFile(join(stateRoot, 'deployment/current.json'), 'utf8')).phase, 'committed')
})

test('failed candidate health atomically rolls back to the prior compatible release', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'openlink-upgrade-rollback-'))
  t.after(async () => (await import('node:fs/promises')).rm(stateRoot, { recursive: true, force: true }))
  const events = []
  await assert.rejects(executeUpgradeTransaction({
    transactionId: 'upgrade-2', stateRoot,
    currentManifest: manifest('release-a', 1), candidateManifest: manifest('release-b', 2),
    stopService: async () => events.push('stop'), backup: async () => ({ id: 'backup-2' }), stage: async () => undefined,
    activate: async (id) => events.push(`activate:${id}`), startService: async () => events.push('start'),
    healthCheck: async (id) => { events.push(`health:${id}`); if (id === 'release-b') throw new Error('candidate unhealthy') },
  }), /candidate unhealthy/i)
  assert.deepEqual(events, ['stop', 'activate:release-b', 'start', 'health:release-b', 'stop', 'activate:release-a', 'start', 'health:release-a'])
  assert.equal(JSON.parse(await readFile(join(stateRoot, 'deployment/current.json'), 'utf8')).phase, 'rolled-back')
})

test('upgrade refuses undeclared or irreversible state schema transitions', () => {
  assert.throws(() => assertUpgradeCompatible(manifest('a', 1, 1), manifest('b', 2, 2, 1, 2)), /migration|reversible/i)
  assert.throws(() => assertUpgradeCompatible(manifest('a', 1, 1), { releaseId: 'b', releaseSequence: 2 }), /compatibility/i)
  assert.throws(() => assertUpgradeCompatible(manifest('a', 2, 1), manifest('b', 2, 1)), /sequence.*newer/i)
  assert.throws(() => assertUpgradeCompatible(manifest('a', 2, 1), manifest('b', 1, 1)), /sequence.*newer/i)
})

test('failure before activation restarts the unchanged release', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'openlink-upgrade-preactivation-'))
  t.after(async () => (await import('node:fs/promises')).rm(stateRoot, { recursive: true, force: true }))
  const events = []
  await assert.rejects(executeUpgradeTransaction({
    transactionId: 'upgrade-3', stateRoot, currentManifest: manifest('release-a', 1), candidateManifest: manifest('release-b', 2),
    stopService: async () => events.push('stop'), backup: async () => { throw new Error('backup failed') }, stage: async () => undefined,
    activate: async () => undefined, startService: async () => events.push('start'), healthCheck: async (id) => events.push(`health:${id}`),
  }), /backup failed/i)
  assert.deepEqual(events, ['stop', 'start', 'health:release-a'])
})

test('manual rollback is schema-safe, backed up, health-gated, and self-restoring', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'openlink-manual-rollback-'))
  t.after(async () => (await import('node:fs/promises')).rm(stateRoot, { recursive: true, force: true }))
  assert.equal(assertRollbackCompatible(manifest('release-b', 2), manifest('release-a', 1)), true)
  assert.throws(() => assertRollbackCompatible(manifest('release-b', 2, 2), manifest('release-a', 1, 1)), /state schema|reversible/i)
  assert.throws(() => assertRollbackCompatible(manifest('release-b', 2), manifest('release-c', 3)), /older/i)
  const events = []
  await assert.rejects(executeRollbackTransaction({
    transactionId: 'rollback-1', stateRoot,
    currentManifest: manifest('release-b', 2), targetManifest: manifest('release-a', 1),
    stopService: async () => events.push('stop'), backup: async () => { events.push('backup'); return { id: 'backup-r1' } },
    activate: async (id) => events.push(`activate:${id}`), startService: async () => events.push('start'),
    healthCheck: async (id) => { events.push(`health:${id}`); if (id === 'release-a') throw new Error('target unhealthy') },
  }), /target unhealthy/i)
  assert.deepEqual(events, ['stop', 'backup', 'activate:release-a', 'start', 'health:release-a', 'stop', 'activate:release-b', 'start', 'health:release-b'])
  assert.equal(JSON.parse(await readFile(join(stateRoot, 'deployment/current.json'), 'utf8')).phase, 'rolled-back')
})
