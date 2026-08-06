import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

function argumentsFrom(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value) throw new Error(`Invalid argument near ${key ?? '<end>'}`)
    values.set(key.slice(2), value)
  }
  return values
}

function safeId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error('release-id is invalid')
  return value
}

function safeRemoteRoot(value) {
  if (!/^\/(?:[A-Za-z0-9._-]+\/?)*$/.test(value) || value.split('/').includes('..')) throw new Error('remote-root is invalid')
  return value.replace(/\/+$/, '') || '/'
}

async function command(file, args, options = {}) {
  process.stdout.write(`> ${file} ${args.join(' ')}\n`)
  await run(file, args, { cwd: root, maxBuffer: 16 * 1024 * 1024, ...options })
}

const args = argumentsFrom(process.argv.slice(2))
const releaseId = safeId(args.get('release-id') || new Date().toISOString().replace(/[:]/g, '-'))
const remoteRoot = safeRemoteRoot(args.get('remote-root') || '/var/lib/openlink-agent')
const platform = args.get('platform') || 'linux/amd64'
if (!/^linux\/(amd64|arm64)$/.test(platform)) throw new Error('platform must be linux/amd64 or linux/arm64')
const outputRoot = resolve(args.get('output') || join(root, '.openlink-releases'))
const releaseDirectory = join(outputRoot, releaseId)
const staging = await mkdtemp(join(tmpdir(), 'openlink-agent-release-'))
const imagesDirectory = join(staging, 'images')
const configDirectory = join(staging, 'config')

const serverImage = `openlink/opensandbox-server:${releaseId}`
const execdImage = `openlink/opensandbox-execd:${releaseId}`
const egressImage = `openlink/opensandbox-egress:${releaseId}`
const rpcImage = `openlink/agent-rpc-worker:${releaseId}`

try {
  await command(process.execPath, ['scripts/sync-pi-runtime.mjs', '--check'])
  await mkdir(imagesDirectory, { recursive: true })
  await mkdir(configDirectory, { recursive: true })
  await mkdir(releaseDirectory, { recursive: true })

  await command('docker', ['buildx', 'build', '--platform', platform, '--load', '-t', serverImage, 'services/opensandbox/server'])
  await command('docker', ['buildx', 'build', '--platform', platform, '--load', '-f', 'services/opensandbox/components/execd/Dockerfile', '-t', execdImage, 'services/opensandbox'])
  await command('docker', ['buildx', 'build', '--platform', platform, '--load', '-f', 'services/opensandbox/components/egress/Dockerfile', '-t', egressImage, 'services/opensandbox'])
  await command('docker', ['buildx', 'build', '--platform', platform, '--load', '-f', 'services/agent-rpc-worker/Dockerfile', '-t', rpcImage, '.'])
  await command('docker', ['save', '-o', join(imagesDirectory, 'openlink-agent-images.tar'), serverImage, execdImage, egressImage, rpcImage])

  await cp(join(root, 'services/agent-remote-release/compose.yaml'), join(staging, 'compose.yaml'))
  const template = await readFile(join(root, 'services/agent-remote-release/opensandbox.toml.template'), 'utf8')
  const config = template
    .replaceAll('__REMOTE_ROOT__', remoteRoot)
    .replaceAll('__EXECD_IMAGE__', execdImage)
    .replaceAll('__EGRESS_IMAGE__', egressImage)
  await writeFile(join(configDirectory, 'opensandbox.toml'), config, { mode: 0o644 })
  await writeFile(join(staging, 'runtime.env.example'), [
    `OPENLINK_REMOTE_ROOT=${remoteRoot}`,
    `OPENLINK_OPENSANDBOX_SERVER_IMAGE=${serverImage}`,
    'OPENLINK_OPENSANDBOX_BIND_PORT=43122',
    'OPENSANDBOX_SERVER_API_KEY=replace-at-deploy-time',
    '',
  ].join('\n'), { mode: 0o600 })

  const archive = join(releaseDirectory, 'openlink-agent-bundle.tar.gz')
  await command('tar', ['-czf', archive, '-C', staging, '.'])
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex')
  const remoteArchive = `${remoteRoot}/releases/${releaseId}/${basename(archive)}`
  const checksum = join(releaseDirectory, 'bundle.sha256')
  await writeFile(checksum, `${digest}  ${remoteArchive}\n`, { mode: 0o644 })
  const opensandboxCommit = (await run('git', ['-C', 'services/opensandbox', 'rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  const piCommit = (await run('git', ['-C', 'services/pi', 'rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  const piRuntimeManifestSha256 = createHash('sha256')
    .update(await readFile(join(root, 'packages/pi-runtime/manifest.json')))
    .digest('hex')
  await writeFile(join(releaseDirectory, 'release.json'), JSON.stringify({
    releaseId,
    platform,
    remoteRoot,
    bundleSha256: digest,
    opensandboxCommit,
    piCommit,
    piRuntimeManifestSha256,
    images: { serverImage, execdImage, egressImage, rpcImage },
  }, null, 2) + '\n')
  process.stdout.write(`${JSON.stringify({ releaseId, archive, checksum, bundleSha256: digest }, null, 2)}\n`)
} finally {
  await rm(staging, { recursive: true, force: true })
}
