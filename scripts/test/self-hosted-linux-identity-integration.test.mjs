import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { installNativeService } from '../../deploy/self-hosted/runtime/native-service.mjs'
import { isolatedProcessInvocation } from '../../deploy/self-hosted/runtime/production-runtime.mjs'

const execFile = promisify(execFileCallback)
const enabled = process.platform === 'linux' && process.getuid?.() === 0 && process.env.OPENLINK_RUN_PRIVILEGED_TESTS === '1'

test('privileged Linux install enforces kernel identities and root-only aggregate secrets', { skip: enabled ? false : 'requires Linux root and OPENLINK_RUN_PRIVILEGED_TESTS=1' }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'openlink-linux-identities-'))
  t.after(async () => (await import('node:fs/promises')).rm(temporary, { recursive: true, force: true }))
  const releaseRoot = join(temporary, 'release')
  const configRoot = join(temporary, 'config')
  const configPath = join(configRoot, 'openlink.env')
  const secretsPath = join(configRoot, 'secrets.env')
  const backupKeyPath = join(configRoot, 'backup.key')
  const stateRoot = '/var/lib/openlink'
  await mkdir(join(releaseRoot, 'systemd'), { recursive: true })
  await mkdir(configRoot, { recursive: true })
  const repository = new URL('../../', import.meta.url)
  await writeFile(join(releaseRoot, 'systemd/openlink.service'), await readFile(new URL('deploy/self-hosted/systemd/openlink.service', repository)))
  await writeFile(join(releaseRoot, 'systemd/openlink-container-broker.service'), await readFile(new URL('deploy/self-hosted/systemd/openlink-container-broker.service', repository)))
  await writeFile(configPath, 'OPENLINK_STATE_ROOT=/var/lib/openlink\n', { mode: 0o600 })
  await writeFile(secretsPath, 'OPENLINK_TEST_SECRET=not-readable-by-service-identities\n', { mode: 0o600 })
  await writeFile(backupKeyPath, 'fixture-backup-key\n', { mode: 0o600 })
  await installNativeService({
    platform: 'linux', releaseRoot, installRoot: join(temporary, 'install'), configPath, secretsPath, backupKeyPath,
    stateRoot, logRoot: '/var/log/openlink', backupRoot: '/var/backups/openlink',
    unitPath: join(temporary, 'openlink.service'), brokerUnitPath: join(temporary, 'openlink-container-broker.service'),
    allowCustomPaths: true,
    execFile: async (command, args, options) => {
      if (command === 'systemctl') return { stdout: args[0] === 'is-active' ? 'active\n' : '' }
      return execFile(command, args, options)
    },
  })
  assert.equal((await lstat(secretsPath)).mode & 0o777, 0o600)
  assert.equal((await lstat(stateRoot)).mode & 0o777, 0o711)
  const agentGroups = (await execFile('id', ['-Gn', 'openlink-agent'])).stdout.trim().split(/\s+/)
  assert.equal(agentGroups.includes('kvm'), true)
  assert.equal(agentGroups.includes('openlink-workspace'), true)
  assert.equal(agentGroups.includes('docker'), false)
  for (const account of ['openlink', 'openlink-browser', 'openlink-knowledge', 'openlink-agent', 'openlink-desktop', 'openlink-web', 'openlink-edge']) {
    const groups = (await execFile('id', ['-Gn', account])).stdout.trim().split(/\s+/)
    if (account !== 'openlink-agent') assert.equal(groups.includes('docker'), false)
  }
  await assert.rejects(execFile('runuser', ['-u', 'openlink-web', '--', process.execPath, '-e', `require('node:fs').readFileSync(${JSON.stringify(secretsPath)})`]))
  const invocation = isolatedProcessInvocation({ name: 'web', identity: 'openlink-web', command: '/usr/bin/id', args: ['-un'] }, { platform: 'linux', root: true })
  assert.equal((await execFile(invocation.command, invocation.args)).stdout.trim(), 'openlink-web')
  await chmod(stateRoot, 0o711)
})
