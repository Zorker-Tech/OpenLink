import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { installNativeService } from '../../deploy/self-hosted/runtime/native-service.mjs'

const root = new URL('../../', import.meta.url)

function serviceBlock(source, name) {
  const match = source.match(new RegExp(`(?:^|\\n)  ${name}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:\\n|$)`))
  assert.ok(match, `missing service ${name}`)
  return match[1]
}

test('systemd unit runs only the active prebuilt release with hardened state paths', async () => {
  const source = await readFile(new URL('deploy/self-hosted/systemd/openlink.service', root), 'utf8')
  assert.match(source, /^User=root$/m)
  assert.match(source, /^Group=root$/m)
  assert.doesNotMatch(source, /^SupplementaryGroups=/m)
  assert.match(source, /^Requires=openlink-container-broker\.service$/m)
  assert.match(source, /^ExecStart=\/opt\/openlink\/current\/bin\/openlinkctl run /m)
  assert.match(source, /^Restart=on-failure$/m)
  assert.match(source, /^TimeoutStopSec=180$/m)
  assert.match(source, /^UMask=0077$/m)
  assert.match(source, /^TasksMax=4096$/m)
  assert.match(source, /^MemoryMax=16G$/m)
  assert.match(source, /^MemorySwapMax=2G$/m)
  assert.match(source, /^CPUQuota=800%$/m)
  assert.match(source, /^ProtectSystem=strict$/m)
  assert.match(source, /^NoNewPrivileges=true$/m)
  assert.match(source, /^AmbientCapabilities=CAP_SETUID CAP_SETGID CAP_SETPCAP CAP_NET_BIND_SERVICE$/m)
  assert.match(source, /^CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_SETPCAP CAP_NET_BIND_SERVICE$/m)
  assert.match(source, /^DevicePolicy=closed$/m)
  assert.match(source, /^DeviceAllow=\/dev\/kvm rw$/m)
  assert.match(source, /^ProtectKernelLogs=true$/m)
  assert.match(source, /^ProtectClock=true$/m)
  assert.match(source, /^ProtectProc=invisible$/m)
  assert.match(source, /^SystemCallArchitectures=native$/m)
  assert.match(source, /^KeyringMode=private$/m)
  assert.doesNotMatch(source, /(password|secret|token)=/i)
  assert.doesNotMatch(source, /(?:npm|pnpm|yarn|next|tsc|go|docker|podman) (?:install|build|pull)/i)
})

test('container broker is root-isolated, Unix-only and accepts no customer command line', async () => {
  const source = await readFile(new URL('deploy/self-hosted/systemd/openlink-container-broker.service', root), 'utf8')
  assert.match(source, /^User=root$/m)
  assert.match(source, /^Group=openlink$/m)
  assert.match(source, /^ExecStart=\/opt\/openlink\/current\/bin\/openlinkctl container-broker --config \/etc\/openlink\/openlink\.env$/m)
  assert.match(source, /^RestrictAddressFamilies=AF_UNIX$/m)
  assert.match(source, /^PrivateNetwork=true$/m)
  assert.match(source, /^RestrictNamespaces=true$/m)
  assert.match(source, /^UMask=0077$/m)
  assert.match(source, /^TasksMax=512$/m)
  assert.match(source, /^MemoryMax=1G$/m)
  assert.match(source, /^MemorySwapMax=256M$/m)
  assert.match(source, /^CPUQuota=400%$/m)
  assert.match(source, /^CapabilityBoundingSet=$/m)
  assert.match(source, /^NoNewPrivileges=true$/m)
  assert.doesNotMatch(source, /(password|secret|token)=/i)
})

test('Project Container broker owns Docker while Agent Host receives only a Unix RPC socket', async () => {
  const source = await readFile(new URL('deploy/self-hosted/systemd/openlink-project-container-broker.service', root), 'utf8')
  assert.match(source, /^User=root$/m)
  assert.match(source, /^Group=openlink-agent$/m)
  assert.match(source, /^ExecStart=\/opt\/openlink\/current\/runtime\/node\/bin\/node \/opt\/openlink\/current\/services\/agent-host\/dist\/src\/project-container-main\.js$/m)
  assert.match(source, /^NoNewPrivileges=true$/m)
  assert.match(source, /^CapabilityBoundingSet=$/m)
  assert.match(source, /^ReadWritePaths=\/var\/lib\/openlink \/run\/openlink-project-container-broker$/m)
  const lifecycle = await readFile(new URL('deploy/self-hosted/runtime/native-service.mjs', root), 'utf8')
  assert.match(lifecycle, /agent: \{ name: 'openlink-agent', groups: \['kvm', 'openlink-workspace'\] \}/)
  assert.doesNotMatch(lifecycle, /agent: \{[^\n]*docker/)
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
  assert.match(source, /^\s*admin off$/m)
  assert.doesNotMatch(source, /admin 127\.0\.0\.1/)
  assert.match(source, /reverse_proxy 127\.0\.0\.1:3000/)
  assert.match(source, /reverse_proxy 127\.0\.0\.1:43121/)
  assert.doesNotMatch(source, /127\.0\.0\.1:(?:43120|43123|43124|54380|19530|9091)/)
  assert.match(source, /Strict-Transport-Security/)
})

test('production Compose overlays bound memory, CPU, processes and local logs for every container', async () => {
  const zokerbase = await readFile(new URL('deploy/self-hosted/orchestration/docker-compose.production.yml', root), 'utf8')
  const zero = await readFile(new URL('deploy/self-hosted/orchestration/docker-compose.zero-production.yml', root), 'utf8')
  for (const name of ['studio', 'kong', 'auth', 'rest', 'realtime', 'supavisor', 'storage', 'imgproxy', 'meta', 'functions', 'db']) {
    const block = serviceBlock(zokerbase, name)
    assert.match(block, /    mem_limit: /)
    assert.match(block, /    cpus: /)
    assert.match(block, /    pids_limit: /)
    assert.match(block, /    logging: /)
  }
  for (const name of ['etcd', 'minio', 'zero']) {
    const block = serviceBlock(zero, name)
    assert.match(block, /    mem_limit: /)
    assert.match(block, /    cpus: /)
    assert.match(block, /    pids_limit: /)
    assert.match(block, /    logging: /)
  }
  assert.match(zokerbase, /max-size: 20m, max-file: "5"/)
  assert.match(zero, /max-size: 20m, max-file: "5"/)
})

test('Linux service installation fixes ownership, enables systemd and verifies active state', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'openlink-native-service-'))
  t.after(async () => (await import('node:fs/promises')).rm(temporary, { recursive: true, force: true }))
  const releaseRoot = join(temporary, 'release')
  const configPath = join(temporary, 'config/openlink.env')
  const secretsPath = join(temporary, 'config/secrets.env')
  const backupKeyPath = join(temporary, 'config/backup.key')
  const unitPath = join(temporary, 'systemd/openlink.service')
  const brokerUnitPath = join(temporary, 'systemd/openlink-container-broker.service')
  const projectBrokerUnitPath = join(temporary, 'systemd/openlink-project-container-broker.service')
  await mkdir(join(releaseRoot, 'systemd'), { recursive: true })
  await mkdir(join(configPath, '..'), { recursive: true })
  await writeFile(join(releaseRoot, 'systemd/openlink.service'), await readFile(new URL('deploy/self-hosted/systemd/openlink.service', root)))
  await writeFile(join(releaseRoot, 'systemd/openlink-container-broker.service'), await readFile(new URL('deploy/self-hosted/systemd/openlink-container-broker.service', root)))
  await writeFile(join(releaseRoot, 'systemd/openlink-project-container-broker.service'), await readFile(new URL('deploy/self-hosted/systemd/openlink-project-container-broker.service', root)))
  for (const path of [configPath, secretsPath, backupKeyPath]) await writeFile(path, 'fixture\n', { mode: 0o600 })
  const calls = []
  const result = await installNativeService({
    platform: 'linux', releaseRoot, installRoot: join(temporary, 'install'), configPath, secretsPath, backupKeyPath,
    stateRoot: join(temporary, 'state'), logRoot: join(temporary, 'logs'), backupRoot: join(temporary, 'backups'),
    unitPath, brokerUnitPath, projectBrokerUnitPath, allowCustomPaths: true, allowUnprivilegedTest: true, identity: { uid: process.getuid(), gid: process.getgid() },
    rootUid: process.getuid(), rootGid: process.getgid(),
    execFile: async (command, args) => {
      calls.push([command, ...args])
      return { stdout: args[0] === 'is-active' ? 'active\n' : '' }
    },
  })
  assert.equal(result.active, true)
  assert.deepEqual(calls, [
    ['systemctl', 'daemon-reload'],
    ['systemctl', 'enable', '--now', 'openlink-container-broker.service', 'openlink.service'],
    ['systemctl', 'is-active', 'openlink-container-broker.service'],
    ['systemctl', 'is-active', 'openlink.service'],
  ])
  assert.equal((await lstat(unitPath)).mode & 0o777, 0o644)
  assert.equal((await lstat(configPath)).mode & 0o777, 0o640)
  assert.equal((await lstat(secretsPath)).mode & 0o777, 0o600)
  assert.equal((await lstat(backupKeyPath)).mode & 0o777, 0o600)
  assert.equal((await lstat(join(temporary, 'state'))).mode & 0o777, 0o711)
  assert.equal((await lstat(brokerUnitPath)).mode & 0o777, 0o644)
  assert.equal((await lstat(projectBrokerUnitPath)).mode & 0o777, 0o644)
})

test('Linux identity setup creates per-process accounts and replaces legacy supplementary groups', async () => {
  const source = await readFile(new URL('deploy/self-hosted/runtime/native-service.mjs', root), 'utf8')
  for (const account of ['openlink-browser', 'openlink-knowledge', 'openlink-agent', 'openlink-desktop', 'openlink-web', 'openlink-edge']) assert.match(source, new RegExp(account))
  assert.match(source, /agent: \{ name: 'openlink-agent', groups: \['kvm', 'openlink-workspace'\] \}/)
  assert.match(source, /await command\(runner, 'usermod', \['--home', stateRoot, '--shell', '\/usr\/sbin\/nologin', '--gid', name, '--groups', groups\.join\(','\), name\]\)/)
  assert.doesNotMatch(source, /usermod', \['--append'/)
})

test('Linux service installation restores previous units and service state after activation failure', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'openlink-native-service-rollback-'))
  t.after(async () => (await import('node:fs/promises')).rm(temporary, { recursive: true, force: true }))
  const releaseRoot = join(temporary, 'release')
  const configPath = join(temporary, 'config/openlink.env')
  const secretsPath = join(temporary, 'config/secrets.env')
  const backupKeyPath = join(temporary, 'config/backup.key')
  const unitPath = join(temporary, 'systemd/openlink.service')
  const brokerUnitPath = join(temporary, 'systemd/openlink-container-broker.service')
  const projectBrokerUnitPath = join(temporary, 'systemd/openlink-project-container-broker.service')
  await mkdir(join(releaseRoot, 'systemd'), { recursive: true })
  await mkdir(join(configPath, '..'), { recursive: true })
  await mkdir(join(unitPath, '..'), { recursive: true })
  await writeFile(join(releaseRoot, 'systemd/openlink.service'), await readFile(new URL('deploy/self-hosted/systemd/openlink.service', root)))
  await writeFile(join(releaseRoot, 'systemd/openlink-container-broker.service'), await readFile(new URL('deploy/self-hosted/systemd/openlink-container-broker.service', root)))
  await writeFile(join(releaseRoot, 'systemd/openlink-project-container-broker.service'), await readFile(new URL('deploy/self-hosted/systemd/openlink-project-container-broker.service', root)))
  for (const path of [configPath, secretsPath, backupKeyPath]) await writeFile(path, 'fixture\n', { mode: 0o600 })
  await writeFile(unitPath, 'previous main unit\n', { mode: 0o600 })
  await writeFile(brokerUnitPath, 'previous broker unit\n', { mode: 0o600 })
  const calls = []
  await assert.rejects(installNativeService({
    platform: 'linux', releaseRoot, installRoot: join(temporary, 'install'), configPath, secretsPath, backupKeyPath,
    stateRoot: join(temporary, 'state'), logRoot: join(temporary, 'logs'), backupRoot: join(temporary, 'backups'),
    unitPath, brokerUnitPath, projectBrokerUnitPath, allowCustomPaths: true, allowUnprivilegedTest: true, identity: { uid: process.getuid(), gid: process.getgid() },
    rootUid: process.getuid(), rootGid: process.getgid(),
    execFile: async (command, args) => {
      calls.push([command, ...args])
      if (args[0] === 'is-enabled') return { stdout: 'enabled\n' }
      if (args[0] === 'is-active') return { stdout: 'active\n' }
      if (args[0] === 'enable' && args[1] === '--now') throw new Error('simulated service activation failure')
      return { stdout: '' }
    },
  }), /simulated service activation failure/i)
  assert.equal(await readFile(unitPath, 'utf8'), 'previous main unit\n')
  assert.equal(await readFile(brokerUnitPath, 'utf8'), 'previous broker unit\n')
  assert.equal((await lstat(unitPath)).mode & 0o777, 0o600)
  assert.equal((await lstat(brokerUnitPath)).mode & 0o777, 0o600)
  assert.equal(calls.some((call) => call.join(' ') === 'systemctl start openlink-container-broker.service'), true)
  assert.equal(calls.some((call) => call.join(' ') === 'systemctl start openlink.service'), true)
})
