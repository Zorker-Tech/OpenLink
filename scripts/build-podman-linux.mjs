import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { ensurePodmanBuilder, run, runCapture, stopPodmanBuilder } from './lib/podman-builder.mjs'
import { configureBundledPodmanRuntime } from './lib/bundled-podman-runtime.mjs'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
await configureBundledPodmanRuntime(root)
const source = resolve(root, 'services/linux')
const hostPodman = process.env.OPENLINK_PODMAN_COMMAND || resolve(root, '.openlink-runtime/toolchain/bin/podman')
const commandOutput = promisify(execFile)

function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value) throw new Error(`Invalid argument near ${key ?? '<end>'}`)
    values.set(key.slice(2), value)
  }
  return values
}

function safePlatform(value) {
  if (!/^linux\/(amd64|arm64)$/.test(value)) throw new Error('platform must be linux/amd64 or linux/arm64')
  return value
}

function safeOutput(value) {
  if (!value || value.includes('\0') || value.includes('\n')) throw new Error('output is invalid')
  return resolve(value)
}

async function executable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function sourceFingerprint(platform) {
  const [head, diff, untracked] = await Promise.all([
    commandOutput('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
    commandOutput('git', ['-C', source, 'diff', '--binary', '--no-ext-diff', 'HEAD'], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 }),
    commandOutput('git', ['-C', source, 'ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }),
  ])
  const hash = createHash('sha256')
  hash.update(JSON.stringify({ schemaVersion: 1, platform, head: head.stdout.trim() }))
  hash.update(diff.stdout)
  const files = untracked.stdout.toString('utf8').split('\0').filter(Boolean).sort()
  for (const file of files) {
    hash.update(file)
    hash.update('\0')
    hash.update(await readFile(resolve(source, file)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

const args = parseArgs(process.argv.slice(2))
const platform = safePlatform(args.get('platform') ?? 'linux/amd64')
const output = safeOutput(args.get('output') ?? resolve(root, '.openlink-runtime/toolchain/linux', platform.slice('linux/'.length), 'podman'))
const architecture = platform.slice('linux/'.length)
const outputDirectory = dirname(output)
const manifestPath = `${output}.manifest.json`
await mkdir(outputDirectory, { recursive: true, mode: 0o700 })

const fingerprint = await sourceFingerprint(platform)
let manifest
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) } catch {}
if ((await executable(output)) && manifest?.fingerprint === fingerprint && manifest?.platform === platform) {
  process.stdout.write(`${JSON.stringify({ platform, source: basename(source), output, fingerprint, reused: true })}\n`)
  process.exit(0)
}

if (!(await executable(hostPodman))) {
  await run(process.execPath, ['scripts/ensure-podman-toolchain.mjs'], { cwd: root })
}
let builder
let connectionArgs = []
const tag = `openlink/podman-linux-build:${fingerprint.slice(0, 20)}-${architecture}`
const containerfile = `FROM golang:1.25.9-bookworm AS build
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends make gcc g++ pkg-config libseccomp-dev libsystemd-dev libgpgme-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN make GOOS=linux GOARCH=${architecture} CGO_ENABLED=1 GOFLAGS=-mod=vendor podman
RUN cp /src/bin/podman /podman
FROM scratch
COPY --from=build /podman /podman
`
const containerName = `openlink-podman-export-${process.pid}`
const temporaryOutput = `${output}.${process.pid}.tmp`
try {
  builder = await ensurePodmanBuilder(hostPodman, { cwd: root })
  connectionArgs = builder.connectionArgs
  await run(hostPodman, [
    ...connectionArgs,
    'build',
    '--platform', platform,
    '--tag', tag,
    '--file', '-',
    source,
  ], { cwd: root, input: containerfile })

  await rm(temporaryOutput, { force: true })
  await runCapture(hostPodman, [...connectionArgs, 'create', '--name', containerName, tag], { cwd: root })
  await run(hostPodman, [...connectionArgs, 'cp', `${containerName}:/podman`, temporaryOutput], { cwd: root })
  await chmod(temporaryOutput, 0o755)
  await rename(temporaryOutput, output)
} finally {
  await runCapture(hostPodman, [...connectionArgs, 'rm', '--force', containerName], { cwd: root }).catch(() => {})
  await rm(temporaryOutput, { force: true })
  if (builder) await stopPodmanBuilder(hostPodman, builder.machineName, { cwd: root })
}

if (!(await executable(output))) throw new Error(`Podman build did not produce ${output}`)
await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, platform, fingerprint, output, builtAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`${JSON.stringify({ platform, source: basename(source), output, fingerprint, reused: false })}\n`)
