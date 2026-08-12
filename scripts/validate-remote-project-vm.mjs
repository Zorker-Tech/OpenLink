#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PodmanProjectRuntimeServiceDriver, ProjectRuntimeManager } from '../services/agent-host/dist/src/project-runtime.js'
import { ProjectVmManager } from '../services/agent-host/dist/src/project-vm.js'
import { RemoteQemuProjectVmDriver } from '../services/agent-host/dist/src/remote-project-vm.js'
import { SshTransport } from '../services/agent-host/dist/src/ssh.js'

const GIB = 1024 ** 3
const diskGb = 64

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function integer(name, fallback, min, max) {
  const value = process.env[name]?.trim()
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} is invalid`)
  return parsed
}

function remotePath(value, name) {
  if (!value.startsWith('/') || value.includes('..') || /[\r\n\0]/.test(value)) throw new Error(`${name} must be a safe absolute path`)
  return value.replace(/\/+$/, '') || '/'
}

async function healthy(url, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  const body = await response.text()
  assert.equal(response.status, 200, `${label} returned HTTP ${response.status}: ${body.slice(0, 500)}`)
  return body
}

async function validateGuest(driver, descriptor) {
  const requiredTools = ['git', 'node', 'npm', 'pnpm', 'python3', 'pip3', 'gcc', 'g++', 'make', 'cmake', 'curl', 'jq', 'rg', 'ssh', 'podman']
  await driver.runInMachine(descriptor.machineName, 'bash', [
    '-lc',
    `set -eu; for required in ${requiredTools.join(' ')}; do command -v "$required" >/dev/null; done; test "$(df --output=size -B1 / | tail -1 | tr -d ' ')" -ge ${60 * GIB}`,
  ])

  const network = `openlink-project-${descriptor.projectId.replaceAll('-', '').slice(0, 16)}`
  const containers = [`${network}-opensandbox`, `${network}-browser`, `${network}-code-server`]
  for (const container of containers) {
    const inspection = await driver.runInMachine(descriptor.machineName, 'sudo', [
      '-n', 'podman', 'inspect', '--format', '{{.State.Running}}', container,
    ])
    assert.equal(inspection.stdout.trim(), 'true', `${container} is not running`)
  }

  const images = [
    'openlink/opensandbox-server:dev',
    'openlink/browser-host:dev',
    'openlink/code-server:dev',
    'openlink/opensandbox-execd:dev',
    'openlink/opensandbox-egress:dev',
    'openlink/agent-worker:dev',
    'openlink/agent-rpc-worker:dev',
  ]
  for (const image of images) {
    await driver.runInMachine(descriptor.machineName, 'sudo', ['-n', 'podman', 'image', 'exists', image])
  }

  const [worker, rpcWorker] = await Promise.all([
    driver.runInMachine(descriptor.machineName, 'sudo', ['-n', 'podman', 'run', '--rm', '--entrypoint', 'node', 'openlink/agent-worker:dev', '--version']),
    driver.runInMachine(descriptor.machineName, 'sudo', ['-n', 'podman', 'run', '--rm', '--entrypoint', 'node', 'openlink/agent-rpc-worker:dev', '--version']),
  ])
  assert.match(worker.stdout.trim(), /^v24\./, 'Agent Worker does not run on the complete Node 24 runtime')
  assert.match(rpcWorker.stdout.trim(), /^v24\./, 'RPC Worker does not run on the complete Node 24 runtime')

  await Promise.all([
    healthy(`${descriptor.opensandboxEndpoint}/health`, `${descriptor.diskMode} OpenSandbox`),
    healthy(`${descriptor.browserHostEndpoint}/healthz`, `${descriptor.diskMode} Browser Host`),
    healthy(`${descriptor.codeServerEndpoint}/healthz`, `${descriptor.diskMode} code-server`),
  ])
}

async function diskInfo(transport, remoteRoot, descriptor) {
  const path = `${remoteRoot}/project-vms/${descriptor.machineName}/disk.qcow2`
  const result = await transport.execRemote('sudo', ['-n', 'qemu-img', 'info', '--force-share', '--output=json', path])
  const value = JSON.parse(result.stdout)
  const virtualSize = Number(value['virtual-size'])
  const actualSize = Number(value['actual-size'])
  assert.equal(virtualSize, diskGb * GIB, `${descriptor.diskMode} disk does not expose ${diskGb} GiB`)
  assert.ok(Number.isSafeInteger(actualSize) && actualSize > 0, `${descriptor.diskMode} disk has invalid physical allocation`)

  if (descriptor.diskMode === 'thin') {
    assert.equal(typeof value['backing-filename'], 'string', 'thin disk is not backed by the immutable base image')
    assert.ok(actualSize < virtualSize * 0.5, `thin disk unexpectedly allocated ${actualSize} of ${virtualSize} bytes`)
  } else {
    assert.equal(value['backing-filename'], undefined, 'thick disk must be independent of the base image')
    assert.ok(actualSize >= virtualSize * 0.95, `thick disk allocated only ${actualSize} of ${virtualSize} bytes`)
  }
  return { virtualSize, actualSize, backingFile: value['backing-filename'] ?? null }
}

const host = required('OPENLINK_VALIDATION_SSH_HOST')
const user = required('OPENLINK_VALIDATION_SSH_USER')
const identityFile = resolve(required('OPENLINK_VALIDATION_SSH_IDENTITY'))
const knownHostsFile = resolve(required('OPENLINK_VALIDATION_SSH_KNOWN_HOSTS'))
const remoteRoot = remotePath(process.env.OPENLINK_VALIDATION_REMOTE_ROOT?.trim() || `/home/${user}/.openlink-agent`, 'OPENLINK_VALIDATION_REMOTE_ROOT')
const releaseDirectory = remotePath(required('OPENLINK_VALIDATION_RELEASE_DIRECTORY'), 'OPENLINK_VALIDATION_RELEASE_DIRECTORY')
const imageArchive = remotePath(process.env.OPENLINK_VALIDATION_IMAGE_ARCHIVE?.trim() || `${releaseDirectory}/images/openlink-agent-images.tar`, 'OPENLINK_VALIDATION_IMAGE_ARCHIVE')
const localStateRoot = resolve(process.env.OPENLINK_VALIDATION_STATE_ROOT?.trim() || '.openlink-runtime/remote-project-vm-validation')
const podmanBinaryPath = remotePath(process.env.OPENLINK_VALIDATION_PODMAN_BINARY?.trim() || `${releaseDirectory}/toolchain/podman`, 'OPENLINK_VALIDATION_PODMAN_BINARY')
const projectIds = {
  thin: process.env.OPENLINK_VALIDATION_THIN_PROJECT_ID?.trim() || randomUUID(),
  thick: process.env.OPENLINK_VALIDATION_THICK_PROJECT_ID?.trim() || randomUUID(),
}

const target = {
  id: 'openlink-project-vm-validation',
  host,
  user,
  port: integer('OPENLINK_VALIDATION_SSH_PORT', 22, 1, 65_535),
  remoteRoot,
}
const transport = new SshTransport(target, {
  identityFile,
  knownHostsFile,
  connectTimeoutSeconds: integer('OPENLINK_VALIDATION_SSH_TIMEOUT_SECONDS', 10, 1, 120),
})
const machineDriver = new RemoteQemuProjectVmDriver({
  transport,
  remoteRoot,
  releaseDirectory,
  podmanBinaryPath,
  podmanSha256: required('OPENLINK_VALIDATION_PODMAN_SHA256'),
  baseImageUrl: required('OPENLINK_VALIDATION_BASE_IMAGE_URL'),
  baseImageSha256: required('OPENLINK_VALIDATION_BASE_IMAGE_SHA256'),
  httpProxy: process.env.OPENLINK_VALIDATION_HTTP_PROXY,
  httpsProxy: process.env.OPENLINK_VALIDATION_HTTPS_PROXY,
})
const vmManager = new ProjectVmManager({
  stateRoot: localStateRoot,
  machineDriver,
  machinePrefix: 'olv',
  backend: 'qemu-kvm',
  guestWorkspaceRoot: '/home/openlink/projects',
  machineSpec: { cpus: 4, memoryMb: 8_192, diskGb, diskMode: 'thin' },
})
const remoteArchive = `remote:${imageArchive}`
const imageArchives = Object.fromEntries([
  'openlink/opensandbox-server:dev',
  'openlink/browser-host:dev',
  'openlink/code-server:dev',
  'openlink/opensandbox-execd:dev',
  'openlink/opensandbox-egress:dev',
  'openlink/agent-worker:dev',
  'openlink/agent-rpc-worker:dev',
].map((image) => [image, remoteArchive]))
const statuses = []
const runtimeManager = new ProjectRuntimeManager({
  stateRoot: localStateRoot,
  vmManager,
  machineDriver,
  serviceDriver: new PodmanProjectRuntimeServiceDriver(machineDriver, { rootful: true }),
  statusWriter: { update: async (update) => { statuses.push(update) } },
  opensandboxImage: 'openlink/opensandbox-server:dev',
  browserHostImage: 'openlink/browser-host:dev',
  codeServerImage: 'openlink/code-server:dev',
  execdImage: 'openlink/opensandbox-execd:dev',
  egressImage: 'openlink/opensandbox-egress:dev',
  agentWorkerImage: 'openlink/agent-worker:dev',
  agentRpcWorkerImage: 'openlink/agent-rpc-worker:dev',
  imageArchives,
  projectPortBase: integer('OPENLINK_VALIDATION_PROJECT_PORT_BASE', 56_000, 1_024, 63_000),
  browserAllowedOrigins: 'http://127.0.0.1:3000',
  publicHost: '127.0.0.1',
})

let failure
try {
  process.stdout.write(`Provisioning simultaneous thin ${projectIds.thin} and thick ${projectIds.thick} Project VMs on ${host}\n`)
  const [thin, thick] = await Promise.all([
    runtimeManager.ensure(projectIds.thin, 'thin'),
    runtimeManager.ensure(projectIds.thick, 'thick'),
  ])
  assert.equal(thin.diskMode, 'thin')
  assert.equal(thick.diskMode, 'thick')

  await Promise.all([validateGuest(machineDriver, thin), validateGuest(machineDriver, thick)])
  const [thinDisk, thickDisk] = await Promise.all([
    diskInfo(transport, remoteRoot, thin),
    diskInfo(transport, remoteRoot, thick),
  ])
  for (const descriptor of [thin, thick]) {
    assert.ok(statuses.some((status) => status.projectId === descriptor.projectId && status.status === 'ready' && status.diskMode === descriptor.diskMode), `${descriptor.diskMode} status projection never reached ready`)
  }
  process.stdout.write(`${JSON.stringify({ ok: true, projects: { thin: { id: thin.projectId, ...thinDisk }, thick: { id: thick.projectId, ...thickDisk } } }, null, 2)}\n`)
} catch (error) {
  failure = error
} finally {
  const cleanup = await Promise.allSettled([
    runtimeManager.remove(projectIds.thin),
    runtimeManager.remove(projectIds.thick),
  ])
  await runtimeManager.close().catch(() => undefined)
  await rm(localStateRoot, { recursive: true, force: true })
  const cleanupErrors = cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason)
  if (!failure && cleanupErrors.length) failure = new AggregateError(cleanupErrors, 'Project VM validation cleanup failed')
  else if (failure && cleanupErrors.length) process.stderr.write(`Cleanup also failed: ${cleanupErrors.map(String).join('; ')}\n`)
}

if (failure) throw failure
