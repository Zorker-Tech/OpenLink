import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProjectContainerBrokerClient, serveProjectContainerBroker } from '../src/project-container-broker.js'
import { HostDockerProjectDriver } from '../src/project-container.js'
import type { ProjectRuntimeController } from '../src/project-runtime-router.js'
import type { ProjectRuntimeDescriptor } from '../src/project-runtime.js'

const projectId = '123e4567-e89b-42d3-a456-426614174000'
const descriptor: ProjectRuntimeDescriptor = {
  projectId, machineName: 'olc-123e4567', workspacePath: '/state/projects/123/workspace', backend: 'docker-container', diskMode: 'thin', status: 'ready',
  servicePorts: { opensandbox: 51000, browserHost: 52000, codeServer: 53000, supabaseGateway: 54000, supabaseDatabase: 55000, supabasePooler: 56000 },
  opensandboxEndpoint: 'http://127.0.0.1:51000', opensandboxApiKey: 'secret', browserHostEndpoint: 'http://127.0.0.1:52000', browserApiToken: 'secret', browserTokenSecret: 'secret', codeServerEndpoint: 'http://127.0.0.1:53000',
  sessionStorageRoot: '/state/projects/123/workspace/.openlink/sessions', agentWorkerImage: 'agent:test', agentRpcWorkerImage: 'rpc:test', codeServerImage: 'code:test',
  supabase: { url: 'http://127.0.0.1:54000', publishableKey: 'sb_publishable_test', anonKey: 'a.b.c', revision: 'test' }, egressMode: 'sidecar',
}

test('Project Container broker exposes project operations without arbitrary execution', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-project-broker-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls: string[] = []
  const controller: ProjectRuntimeController = {
    async ensure(id) { calls.push(`ensure:${id}`); return descriptor },
    async describeSupabase() { return descriptor.supabase },
    async manageSupabase(_id, request) { return { operation: request.operation } },
    async proxySupabaseStudio() { return { status: 200, headers: {}, bodyBase64: '' } },
    async prepareSessionStorage(_id, user, workspace, session) { return `/sessions/${user}/${workspace}/${session}` },
    async persistCodexThreadId(_id, user, workspace, session, thread) { calls.push(`persist:${user}:${workspace}:${session}:${thread}`) },
    async ensureProjectGitRepository() {}, async listGitVersions() { return [] },
    async listWorkspaceFiles() { return ['README.md'] },
    async checkoutGitVersion(_id, ref) { return { ref, shortRef: ref.slice(0, 7), message: 'test', timestamp: new Date(0).toISOString(), current: true } },
    getActive() { return descriptor }, async hasPersistedRuntime() { return true }, async restorePersistedRuntimes() {},
    async discoverPreviewTarget() { return null }, async close() {},
  }
  const broker = await serveProjectContainerBroker(join(root, 'control.sock'), controller)
  t.after(() => broker.close())
  const client = new ProjectContainerBrokerClient(broker.socket)
  assert.deepEqual(await client.ensure(projectId, 'thin'), descriptor)
  assert.equal(client.getActive(projectId)?.backend, 'docker-container')
  assert.deepEqual(await client.manageSupabase(projectId, { operation: 'tables' }), { operation: 'tables' })
  assert.equal(await client.prepareSessionStorage(projectId, 'user', 'workspace', 'session'), '/sessions/user/workspace/session')
  const codexThreadId = '019c6e27-e55b-73d1-87d8-4e01f1f75043'
  await client.persistCodexThreadId(projectId, 'user', 'workspace', 'newsession1', codexThreadId)
  assert.deepEqual(await client.listWorkspaceFiles(projectId), ['README.md'])
  assert.deepEqual(calls, [`ensure:${projectId}`, `persist:user:workspace:newsession1:${codexThreadId}`])
})

test('Project Container broker rejects malformed Codex thread identifiers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-project-broker-thread-id-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const controller = {
    persistCodexThreadId: async () => { throw new Error('must not dispatch') },
  } as unknown as ProjectRuntimeController
  const broker = await serveProjectContainerBroker(join(root, 'control.sock'), controller)
  t.after(() => broker.close())
  const client = new ProjectContainerBrokerClient(broker.socket)
  await assert.rejects(
    client.persistCodexThreadId(projectId, 'user', 'workspace', 'newsession1', '019c6e27-e55b-73d1-not-a-valid-thread'),
    /Codex thread id is invalid/i,
  )
})

test('Project Container broker rejects invalid project identifiers before dispatch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-project-broker-invalid-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const controller = { ensure: async () => { throw new Error('must not dispatch') } } as unknown as ProjectRuntimeController
  const broker = await serveProjectContainerBroker(join(root, 'control.sock'), controller)
  t.after(() => broker.close())
  const client = new ProjectContainerBrokerClient(broker.socket)
  await assert.rejects(client.ensure('not-a-project', 'thin'), /projectId is invalid/i)
})

test('host Container driver maps guest staging into private state and runs the sealed controller with the bundled Node', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-project-container-driver-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  const source = join(root, 'controller.mjs')
  const bundle = join(root, 'bundle.mjs')
  await writeFile(source, '#!/usr/bin/env node\n')
  await writeFile(bundle, 'export const sealed = true\n')
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
  const driver = new HostDockerProjectDriver({
    stateRoot,
    immutableSupabaseRoot: join(root, 'immutable'),
    supabaseReleaseTrust: join(root, 'immutable/release-trust.json'),
    async execFile(command, args, options) { calls.push({ command, args, options }); return { stdout: '{}\n', stderr: '' } },
  })
  const machine = 'olc-123e4567e89b42d3a456426614'
  await driver.copyToMachine(machine, source, '/tmp/project-supabase-runtime.mjs')
  await driver.copyToMachine(machine, bundle, '/tmp/project-supabase-bundle.mjs')
  await driver.runInMachine(machine, 'sudo', ['-n', 'sh', '-c', 'mkdir -p /var/lib/openlink && cp /tmp/project-supabase-runtime.mjs /var/lib/openlink/project-supabase-runtime && cp /tmp/project-supabase-bundle.mjs /var/lib/openlink/project-supabase-bundle.mjs && chmod 0755 /var/lib/openlink/project-supabase-runtime'])
  const installed = join(stateRoot, 'controller/project-supabase-runtime')
  assert.equal(await readFile(installed, 'utf8'), '#!/usr/bin/env node\n')
  assert.equal((await lstat(installed)).mode & 0o777, 0o700)
  await driver.runInMachine(machine, 'sudo', ['-n', '/var/lib/openlink/project-supabase-runtime', 'ensure', '--project-id', projectId])
  assert.equal(calls.at(-1)?.command, process.execPath)
  assert.equal(calls.at(-1)?.args[0], installed)
  await assert.rejects(driver.runInMachine(machine, 'sudo', ['-n', 'sh', '-c', 'id']), /unexpected shell operation/i)
  await assert.rejects(driver.copyToMachine(machine, source, '/tmp/../escape'), /staging path is invalid/i)
})
