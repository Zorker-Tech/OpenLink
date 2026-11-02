import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  projectArchitectureBackend,
  quiesceProjectContainers,
  readProjectMigrationManifest,
  type ProjectMigrationManifest,
} from '../src/project-migration.js'
import type { ProjectVmMachineDriver } from '../src/project-vm.js'

const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'

async function archive(root: string, name: string, value: string) {
  const bytes = Buffer.from(value)
  await writeFile(join(root, name), bytes)
  return { file: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

test('maps each project architecture to its durable VM backend', () => {
  assert.equal(projectArchitectureBackend('t1'), 'qemu-kvm')
  assert.equal(projectArchitectureBackend('e1'), 'podman-machine')
})

test('quiesces with restart policies disabled and restores them without starting containers', async () => {
  const calls: string[][] = []
  let stopped = false
  const driver: ProjectVmMachineDriver = {
    ensureMachine: async () => undefined,
    bootstrapToolchain: async () => undefined,
    stopMachine: async () => undefined,
    removeMachine: async () => undefined,
    runInMachine: async (_machine, command, args = []) => {
      const podmanArgs = command === 'sudo' && args[0] === '-n' && args[1] === 'podman' ? args.slice(2) : [command, ...args]
      calls.push(podmanArgs)
      if (podmanArgs[0] === 'ps' && podmanArgs.includes('--all')) return { stdout: 'abcd1234\n', stderr: '' }
      if (podmanArgs[0] === 'inspect' && podmanArgs[1] === '--format') return { stdout: 'abcd1234 unless-stopped\n', stderr: '' }
      if (podmanArgs[0] === 'stop') { stopped = true; return { stdout: '', stderr: '' } }
      if (podmanArgs[0] === 'ps' && podmanArgs[1] === '--quiet') return { stdout: stopped ? '' : 'abcd1234\n', stderr: '' }
      return { stdout: '', stderr: '' }
    },
  }
  const quiesce = await quiesceProjectContainers(driver, 'olp-test', { rootful: true })
  assert.ok(calls.some((args) => args[0] === 'update' && args.includes('--restart=no') && args.includes('abcd1234')))
  assert.ok(calls.some((args) => args[0] === 'stop' && args.includes('--all')))
  await quiesce.restore()
  assert.ok(calls.some((args) => args[0] === 'update' && args.includes('--restart=unless-stopped') && args.includes('abcd1234')))
  assert.equal(calls.some((args) => args[0] === 'start'), false)
})

test('accepts an intact migration manifest and rejects a tampered archive', async () => {
  const root = await mkdtemp(join('/tmp', 'openlink-project-migration-manifest-'))
  try {
    const workspace = await archive(root, 'workspace.tar', 'workspace-archive')
    const agentTools = await archive(root, 'agent-tools.tar', 'agent-tools-archive')
    const manifest: ProjectMigrationManifest = {
      schemaVersion: 1,
      projectId,
      sourceArchitecture: 't1',
      sourceBackend: 'qemu-kvm',
      createdAt: new Date().toISOString(),
      sourceMachineName: 'olp-test',
      sourceWorkspacePath: '/home/openlink/openlink/projects/test/workspace',
      sourceGuestUser: 'openlink',
      workspace,
      supabase: null,
      agentTools,
    }
    await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`)
    assert.deepEqual(await readProjectMigrationManifest(root), manifest)

    await writeFile(join(root, 'agent-tools.tar'), 'tampered')
    await assert.rejects(() => readProjectMigrationManifest(root), /archive checksum mismatch/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('accepts schema 1 archives created before the tool registry existed', async () => {
  const root = await mkdtemp(join('/tmp', 'openlink-project-migration-legacy-'))
  try {
    const workspace = await archive(root, 'workspace.tar', 'workspace-archive')
    const manifest = {
      schemaVersion: 1,
      projectId,
      sourceArchitecture: 't1',
      sourceBackend: 'qemu-kvm',
      createdAt: new Date().toISOString(),
      sourceMachineName: 'olp-test',
      sourceWorkspacePath: '/home/openlink/openlink/projects/test/workspace',
      sourceGuestUser: 'openlink',
      workspace,
      supabase: null,
    }
    await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`)
    assert.deepEqual(await readProjectMigrationManifest(root), manifest)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects a migration manifest whose archive path escapes the backup directory', async () => {
  const root = await mkdtemp(join('/tmp', 'openlink-project-migration-path-'))
  try {
    const workspace = await archive(root, 'workspace.tar', 'workspace-archive')
    const manifest = {
      schemaVersion: 1,
      projectId,
      sourceArchitecture: 't1',
      sourceBackend: 'qemu-kvm',
      createdAt: new Date().toISOString(),
      sourceMachineName: 'olp-test',
      sourceWorkspacePath: '/home/openlink/openlink/projects/test/workspace',
      sourceGuestUser: 'openlink',
      workspace: { ...workspace, file: '../workspace.tar' },
      supabase: null,
    }
    await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`)
    await assert.rejects(() => readProjectMigrationManifest(root), /archive name is not a safe path component/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
