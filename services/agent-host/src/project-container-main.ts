import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { HostDockerProjectDriver } from './project-container.js'
import { serveProjectContainerBroker } from './project-container-broker.js'
import { PodmanProjectRuntimeServiceDriver, ProjectRuntimeManager } from './project-runtime.js'
import { createSupabaseProjectRuntimeStatusWriter } from './project-runtime-status.js'
import { ProjectVmManager } from './project-vm.js'

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (!value) throw new Error(`${key} is required`)
  return value
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error('Project Container broker numeric configuration is invalid')
  return parsed
}

function archives(value: string | undefined): Record<string, string> | undefined {
  if (!value?.trim()) return undefined
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Project image archives are invalid')
  return Object.fromEntries(Object.entries(parsed).map(([image, archive]) => {
    if (!image || typeof archive !== 'string' || !archive.trim()) throw new Error('Project image archive entry is invalid')
    return [image, resolve(archive)]
  }))
}

async function releaseArchives(releaseRoot: string): Promise<Record<string, string>> {
  const manifest = JSON.parse(await readFile(resolve(releaseRoot, 'images/runtime/manifest.json'), 'utf8')) as { images?: Record<string, { archive?: string }> }
  if (!manifest.images || Array.isArray(manifest.images)) throw new Error('Runtime image manifest is invalid')
  return Object.fromEntries(Object.entries(manifest.images).map(([image, item]) => {
    if (!item.archive || item.archive.startsWith('/') || item.archive.split('/').includes('..')) throw new Error(`Runtime image archive is invalid for ${image}`)
    return [image, join(releaseRoot, 'images/runtime', ...item.archive.split('/'))]
  }))
}

const env = process.env
if (env.OPENLINK_PROJECT_RUNTIME !== 'container') throw new Error('Project Container broker may only run for the Container backend')
const releaseRoot = resolve(required(env, 'OPENLINK_AGENT_RELEASE_ROOT'))
const stateRoot = resolve(env.OPENLINK_PROJECT_CONTAINER_STATE_ROOT || resolve(required(env, 'OPENLINK_STATE_ROOT'), 'project-containers'))
const driver = new HostDockerProjectDriver({
  command: env.OPENLINK_DOCKER_COMMAND || 'docker',
  stateRoot,
  immutableSupabaseRoot: resolve(releaseRoot, 'project-supabase'),
  supabaseStateRoot: resolve(stateRoot, 'project-supabase'),
  supabaseReleaseTrust: resolve(releaseRoot, 'project-supabase/release-trust.json'),
})
const projectManager = new ProjectVmManager({
  stateRoot,
  machineDriver: driver,
  machinePrefix: 'olc',
  backend: 'docker-container',
  guestWorkspaceRoot: resolve(stateRoot, 'projects'),
  machineSpec: {
    cpus: integer(env.OPENLINK_PROJECT_VM_CPUS, 4, 1, 64),
    memoryMb: integer(env.OPENLINK_PROJECT_VM_MEMORY_MB, 8_192, 512, 262_144),
    diskGb: integer(env.OPENLINK_PROJECT_VM_DISK_GB, 64, 10, 4_096),
    diskMode: 'thin',
  },
})
const runtime = new ProjectRuntimeManager({
  stateRoot,
  vmManager: projectManager,
  machineDriver: driver,
  serviceDriver: new PodmanProjectRuntimeServiceDriver(driver, { rootful: true, engine: 'docker', engineSocketPath: '/var/run/docker.sock' }),
  statusWriter: createSupabaseProjectRuntimeStatusWriter(env),
  opensandboxImage: env.OPENLINK_OPENSANDBOX_SERVER_IMAGE || 'openlink/opensandbox-server:dev',
  browserHostImage: env.OPENLINK_BROWSER_HOST_IMAGE || 'openlink/browser-host:dev',
  execdImage: env.OPENLINK_OPENSANDBOX_EXECD_IMAGE || 'openlink/opensandbox-execd:dev',
  egressImage: env.OPENLINK_OPENSANDBOX_EGRESS_IMAGE || 'openlink/opensandbox-egress:dev',
  agentWorkerImage: env.OPENLINK_AGENT_WORKER_IMAGE || 'openlink/agent-worker:dev',
  agentRpcWorkerImage: env.OPENLINK_AGENT_RPC_WORKER_IMAGE || env.OPENLINK_AGENT_WORKER_IMAGE || 'openlink/agent-rpc-worker:dev',
  codeServerImage: env.OPENLINK_CODE_SERVER_IMAGE || 'openlink/code-server:dev',
  imageArchives: archives(env.OPENLINK_PROJECT_RUNTIME_IMAGE_ARCHIVES) ?? await releaseArchives(releaseRoot),
  projectPortBase: integer(env.OPENLINK_PROJECT_RUNTIME_PORT_BASE, 51_000, 1_024, 65_000),
  projectPortRangeSize: integer(env.OPENLINK_PROJECT_RUNTIME_PORT_RANGE_SIZE, 1_000, 1, 64_000),
  browserAllowedOrigins: env.OPENLINK_BROWSER_ALLOWED_ORIGINS || 'http://localhost:3000',
  publicHost: '127.0.0.1',
})
const broker = await serveProjectContainerBroker(required(env, 'OPENLINK_PROJECT_CONTAINER_BROKER_SOCKET'), runtime)
if (process.env.NOTIFY_SOCKET) {
  const { execFile } = await import('node:child_process')
  execFile('systemd-notify', ['--ready', '--status=OpenLink Project Container broker is ready'])
}
await new Promise<void>((accept) => {
  process.once('SIGINT', () => accept())
  process.once('SIGTERM', () => accept())
})
await broker.close()
await runtime.close({ stopRuntimes: false })
