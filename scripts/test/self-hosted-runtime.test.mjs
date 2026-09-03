import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ProductionSupervisor, createRuntimePlan } from '../../deploy/self-hosted/runtime/production-runtime.mjs'
import { acquireRuntimeLock, runtimeLockStatus } from '../../deploy/self-hosted/runtime/lifecycle-lock.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'openlink-production-runtime-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const releaseRoot = join(root, 'release')
  const stateRoot = join(root, 'state')
  const manifests = {
    runtime: { images: { 'openlink/worker:2026.09.03': { archive: 'archives/worker.tar' } } },
    zokerbase: { images: [{ image: 'zokerbase/postgres:2026.09.03', archive: 'postgres.tar' }] },
    zero: { images: [{ image: 'zokerbase/zero:3.0.0', archive: 'zero.tar' }] },
  }
  for (const [name, manifest] of Object.entries(manifests)) {
    const path = join(releaseRoot, 'images', name, 'manifest.json')
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, `${JSON.stringify(manifest)}\n`)
    const entries = Array.isArray(manifest.images) ? manifest.images : Object.values(manifest.images)
    for (const entry of entries) {
      const archive = join(releaseRoot, 'images', name, entry.archive.startsWith('archives/') ? entry.archive : join('archives', entry.archive))
      await mkdir(join(archive, '..'), { recursive: true })
      await writeFile(archive, 'sealed-image\n')
    }
  }
  return { root, releaseRoot, stateRoot }
}

test('production plan uses only sealed artifacts and loopback host services', async (t) => {
  const item = await fixture(t)
  const plan = await createRuntimePlan({
    releaseRoot: item.releaseRoot,
    stateRoot: item.stateRoot,
    environment: { OPENLINK_ZOKERBASE_ENV_FILE: join(item.root, 'zokerbase.env') },
    validate: false,
  })
  assert.equal(plan.images.length, 3)
  assert.deepEqual(plan.processes.map((process) => process.name), ['browser-host', 'knowledge-service', 'agent-host', 'desktop-agent-host', 'web'])
  assert.equal(plan.processes.every((process) => process.environment.OPENLINK_RUNTIME_MODE === 'local'), true)
  assert.equal(plan.processes.every((process) => process.environment.OPENLINK_AGENT_HOST === '127.0.0.1'), true)
  assert.equal(plan.compose.every((item) => item.args.includes('--pull') && item.args.includes('never')), true)
  assert.doesNotMatch(JSON.stringify(plan), /\b(?:npm|pnpm|yarn|tsc)\b|\b(?:build|pull)\b.*(?:source|registry)/i)
})

test('supervisor starts dependencies in order and shuts down application before data stores', async (t) => {
  const item = await fixture(t)
  const events = []
  const children = []
  const childFor = (name) => {
    const child = new EventEmitter()
    child.exitCode = null
    child.signalCode = null
    child.kill = (signal) => {
      events.push(`kill:${name}:${signal}`)
      child.exitCode = 0
      queueMicrotask(() => child.emit('exit', 0, signal))
      return true
    }
    children.push(child)
    return child
  }
  const plan = await createRuntimePlan({ releaseRoot: item.releaseRoot, stateRoot: item.stateRoot, environment: { OPENLINK_ZOKERBASE_ENV_FILE: join(item.root, 'zokerbase.env') }, validate: false })
  const supervisor = new ProductionSupervisor(plan, {
    runCommand: async (_command, args) => { events.push(`command:${args.join(' ')}`); return '' },
    spawnProcess: (_command, _args, options) => { events.push(`spawn:${options.openlinkName}`); return childFor(options.openlinkName) },
    probe: async (url) => { events.push(`probe:${url}`); return true },
    notifyReady: async () => { events.push('ready') },
  })
  await supervisor.start()
  assert.equal(events.at(-1), 'ready')
  assert.equal(events.indexOf('spawn:web') > events.indexOf('spawn:agent-host'), true)
  await supervisor.stop('SIGTERM')
  const firstComposeStop = events.findIndex((event) => event.startsWith('command:compose') && event.includes(' stop'))
  const lastProcessKill = events.map((event, index) => [event, index]).filter(([event]) => event.startsWith('kill:')).at(-1)[1]
  assert.equal(firstComposeStop > lastProcessKill, true)
})

test('a critical child exit fails the runtime and triggers cleanup', async (t) => {
  const item = await fixture(t)
  const children = new Map()
  const plan = await createRuntimePlan({ releaseRoot: item.releaseRoot, stateRoot: item.stateRoot, environment: { OPENLINK_ZOKERBASE_ENV_FILE: join(item.root, 'zokerbase.env') }, validate: false })
  const supervisor = new ProductionSupervisor(plan, {
    runCommand: async () => '',
    spawnProcess: (_command, _args, options) => {
      const child = new EventEmitter()
      child.exitCode = null
      child.signalCode = null
      child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); return true }
      children.set(options.openlinkName, child)
      return child
    },
    probe: async () => true,
    notifyReady: async () => undefined,
  })
  await supervisor.start()
  const failure = supervisor.wait()
  const agent = children.get('agent-host')
  agent.exitCode = 23
  agent.emit('exit', 23)
  await assert.rejects(failure, /agent-host.*23/i)
})

test('runtime lock excludes a live owner and safely replaces a stale owner', async (t) => {
  const item = await fixture(t)
  const first = await acquireRuntimeLock(item.stateRoot, { pid: 101, isPidAlive: (pid) => pid === 101 })
  assert.equal((await runtimeLockStatus(item.stateRoot, { isPidAlive: () => true })).running, true)
  await assert.rejects(acquireRuntimeLock(item.stateRoot, { pid: 202, isPidAlive: (pid) => pid === 101 }), /already active.*101/i)
  await first.release()
  const stale = await acquireRuntimeLock(item.stateRoot, { pid: 303, isPidAlive: () => false })
  const replacement = await acquireRuntimeLock(item.stateRoot, { pid: 404, isPidAlive: () => false })
  assert.equal(replacement.owner.pid, 404)
  await stale.release()
  assert.equal((await runtimeLockStatus(item.stateRoot, { isPidAlive: () => true })).owner.pid, 404)
  await replacement.release()
})
