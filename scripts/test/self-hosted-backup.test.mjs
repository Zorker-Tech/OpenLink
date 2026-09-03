import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createEncryptedBackup, restoreEncryptedBackup } from '../../deploy/self-hosted/runtime/backup.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'openlink-backup-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  const configPath = join(root, 'config/openlink.env')
  const secretsPath = join(root, 'config/secrets.env')
  const keyFile = join(root, 'config/backup.key')
  await mkdir(join(stateRoot, 'zokerbase/postgres'), { recursive: true })
  await mkdir(join(configPath, '..'), { recursive: true })
  await writeFile(join(stateRoot, 'zokerbase/postgres/data.bin'), Buffer.from([0, 1, 2, 3]), { mode: 0o600 })
  await mkdir(join(stateRoot, 'project-vms/vm-1'), { recursive: true })
  await writeFile(join(stateRoot, 'project-vms/vm-1/disk.raw'), '')
  await truncate(join(stateRoot, 'project-vms/vm-1/disk.raw'), 4 * 1024 * 1024)
  await writeFile(configPath, 'OPENLINK_STATE_ROOT=/state\n', { mode: 0o640 })
  await writeFile(secretsPath, 'OPENLINK_AGENT_API_TOKEN=secret\n', { mode: 0o600 })
  await writeFile(keyFile, `${Buffer.alloc(32, 7).toString('base64url')}\n`, { mode: 0o600 })
  await chmod(keyFile, 0o600)
  const archive = join(root, 'backups/fixture.olb')
  return { root, stateRoot, configPath, secretsPath, keyFile, archive, output: archive }
}

test('encrypted backup restores authoritative state and protected configuration into fresh roots', async (t) => {
  const item = await fixture(t)
  const backup = await createEncryptedBackup(item)
  assert.equal(backup.manifest.encryption.algorithm, 'aes-256-gcm')
  await assert.rejects(lstat(join(item.stateRoot, 'run/runtime.lock')), /ENOENT/)
  assert.notEqual((await readFile(item.archive)).includes(Buffer.from('OPENLINK_AGENT_API_TOKEN')), true)
  const restored = {
    archive: item.archive,
    keyFile: item.keyFile,
    stateRoot: join(item.root, 'restored/state'),
    configPath: join(item.root, 'restored/config/openlink.env'),
    secretsPath: join(item.root, 'restored/config/secrets.env'),
  }
  await restoreEncryptedBackup(restored)
  assert.deepEqual(await readFile(join(restored.stateRoot, 'zokerbase/postgres/data.bin')), Buffer.from([0, 1, 2, 3]))
  assert.equal((await lstat(join(restored.stateRoot, 'project-vms/vm-1/disk.raw'))).size, 4 * 1024 * 1024)
  assert.equal(await readFile(restored.secretsPath, 'utf8'), 'OPENLINK_AGENT_API_TOKEN=secret\n')
  await assert.rejects(lstat(join(restored.stateRoot, 'run/runtime.lock')), /ENOENT/)
})

test('backup corruption and the wrong key fail closed without a partial destination', async (t) => {
  const item = await fixture(t)
  await createEncryptedBackup(item)
  const bytes = await readFile(item.archive)
  bytes[Math.floor(bytes.length / 2)] ^= 0xff
  await writeFile(item.archive, bytes)
  await assert.rejects(restoreEncryptedBackup({ archive: item.archive, keyFile: item.keyFile, stateRoot: join(item.root, 'bad/state'), configPath: join(item.root, 'bad/openlink.env'), secretsPath: join(item.root, 'bad/secrets.env') }), /integrity|authentication/i)
})

test('complete backup refuses to run while a live runtime lock exists', async (t) => {
  const item = await fixture(t)
  await mkdir(join(item.stateRoot, 'run/runtime.lock'), { recursive: true })
  await writeFile(join(item.stateRoot, 'run/runtime.lock/owner.json'), `${JSON.stringify({ pid: process.pid })}\n`)
  await assert.rejects(createEncryptedBackup(item), /service.*stopped|PID/i)
})

test('backup preserves contained links but rejects links to host files', async (t) => {
  const item = await fixture(t)
  await mkdir(join(item.stateRoot, 'workspaces/project'), { recursive: true })
  await symlink('../../zokerbase/postgres/data.bin', join(item.stateRoot, 'workspaces/project/data-link'))
  await createEncryptedBackup(item)
  const restored = {
    archive: item.archive,
    keyFile: item.keyFile,
    stateRoot: join(item.root, 'restored/state'),
    configPath: join(item.root, 'restored/config/openlink.env'),
    secretsPath: join(item.root, 'restored/config/secrets.env'),
  }
  await restoreEncryptedBackup(restored)
  assert.equal(await readlink(join(restored.stateRoot, 'workspaces/project/data-link')), '../../zokerbase/postgres/data.bin')
  assert.deepEqual(await readFile(join(restored.stateRoot, 'workspaces/project/data-link')), Buffer.from([0, 1, 2, 3]))

  const unsafe = await fixture(t)
  await mkdir(join(unsafe.stateRoot, 'workspaces/project'), { recursive: true })
  await symlink(unsafe.secretsPath, join(unsafe.stateRoot, 'workspaces/project/leak'))
  await assert.rejects(createEncryptedBackup(unsafe), /symbolic link outside the state root/i)
  await assert.rejects(lstat(unsafe.archive), /ENOENT/)
})
