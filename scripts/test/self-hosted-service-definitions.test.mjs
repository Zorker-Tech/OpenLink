import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { installNativeService } from '../../deploy/self-hosted/runtime/native-service.mjs'

const root = new URL('../../', import.meta.url)

test('systemd unit runs only the active prebuilt release with hardened state paths', async () => {
  const source = await readFile(new URL('deploy/self-hosted/systemd/openlink.service', root), 'utf8')
  assert.match(source, /^User=openlink$/m)
  assert.match(source, /^ExecStart=\/opt\/openlink\/current\/bin\/openlinkctl run /m)
  assert.match(source, /^Restart=on-failure$/m)
  assert.match(source, /^TimeoutStopSec=180$/m)
  assert.match(source, /^UMask=0077$/m)
  assert.match(source, /^ProtectSystem=strict$/m)
  assert.match(source, /^NoNewPrivileges=true$/m)
  assert.match(source, /^AmbientCapabilities=CAP_NET_BIND_SERVICE$/m)
  assert.match(source, /^CapabilityBoundingSet=CAP_NET_BIND_SERVICE$/m)
  assert.match(source, /^ProtectKernelLogs=true$/m)
  assert.match(source, /^ProtectClock=true$/m)
  assert.match(source, /^ProtectProc=invisible$/m)
  assert.match(source, /^SystemCallArchitectures=native$/m)
  assert.match(source, /^KeyringMode=private$/m)
  assert.doesNotMatch(source, /(password|secret|token)=/i)
  assert.doesNotMatch(source, /(?:npm|pnpm|yarn|next|tsc|go|docker|podman) (?:install|build|pull)/i)
})

test('launchd service runs only the active prebuilt release and embeds no credentials', async () => {
  const source = await readFile(new URL('deploy/self-hosted/launchd/io.zokerbase.openlink.plist', root), 'utf8')
  assert.match(source, /<string>\/Library\/Application Support\/OpenLink\/current\/bin\/openlinkctl<\/string>/)
  assert.match(source, /<string>run<\/string>/)
  assert.match(source, /<key>KeepAlive<\/key>/)
  assert.match(source, /<string>openlink<\/string>/)
  assert.doesNotMatch(source, /(password|secret|token)<\/key>/i)
})

test('edge publishes Web and scoped gateway routes but no privileged service port', async () => {
  const source = await readFile(new URL('deploy/self-hosted/edge/Caddyfile', root), 'utf8')
  assert.match(source, /reverse_proxy 127\.0\.0\.1:3000/)
  assert.match(source, /reverse_proxy 127\.0\.0\.1:43121/)
  assert.doesNotMatch(source, /127\.0\.0\.1:(?:43120|43123|43124|54380|19530|9091)/)
  assert.match(source, /Strict-Transport-Security/)
})

test('Linux service installation fixes ownership, enables systemd and verifies active state', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'openlink-native-service-'))
  t.after(async () => (await import('node:fs/promises')).rm(temporary, { recursive: true, force: true }))
  const releaseRoot = join(temporary, 'release')
  const configPath = join(temporary, 'config/openlink.env')
  const secretsPath = join(temporary, 'config/secrets.env')
  const backupKeyPath = join(temporary, 'config/backup.key')
  const unitPath = join(temporary, 'systemd/openlink.service')
  await mkdir(join(releaseRoot, 'systemd'), { recursive: true })
  await mkdir(join(configPath, '..'), { recursive: true })
  await writeFile(join(releaseRoot, 'systemd/openlink.service'), await readFile(new URL('deploy/self-hosted/systemd/openlink.service', root)))
  for (const path of [configPath, secretsPath, backupKeyPath]) await writeFile(path, 'fixture\n', { mode: 0o600 })
  const calls = []
  const result = await installNativeService({
    platform: 'linux', releaseRoot, installRoot: join(temporary, 'install'), configPath, secretsPath, backupKeyPath,
    stateRoot: join(temporary, 'state'), logRoot: join(temporary, 'logs'), backupRoot: join(temporary, 'backups'),
    unitPath, allowCustomPaths: true, allowUnprivilegedTest: true, identity: { uid: process.getuid(), gid: process.getgid() },
    rootUid: process.getuid(),
    execFile: async (command, args) => {
      calls.push([command, ...args])
      return { stdout: args[0] === 'is-active' ? 'active\n' : '' }
    },
  })
  assert.equal(result.active, true)
  assert.deepEqual(calls, [
    ['systemctl', 'daemon-reload'],
    ['systemctl', 'enable', '--now', 'openlink.service'],
    ['systemctl', 'is-active', 'openlink.service'],
  ])
  assert.equal((await lstat(unitPath)).mode & 0o777, 0o644)
  assert.equal((await lstat(configPath)).mode & 0o777, 0o640)
  assert.equal((await lstat(secretsPath)).mode & 0o777, 0o600)
})
