import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ProductionSupervisor, createRuntimePlan, isolatedProcessInvocation } from '../../deploy/self-hosted/runtime/production-runtime.mjs'
import { acquireRuntimeLock, runtimeLockStatus } from '../../deploy/self-hosted/runtime/lifecycle-lock.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'openlink-production-runtime-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const releaseRoot = join(root, 'release')
  const stateRoot = join(root, 'state')
  const imageId = `sha256:${'a'.repeat(64)}`
  const manifests = {
    runtime: { images: { 'openlink/worker:2026.09.03': { archive: 'archives/worker.tar', imageId } } },
    zokerbase: { images: [{ image: 'zokerbase/postgres:2026.09.03', archive: 'postgres.tar', imageId }] },
    zero: { images: [{ image: 'zokerbase/zero:3.0.0', archive: 'zero.tar', imageId }] },
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
  await mkdir(join(releaseRoot, 'browser/chromium'), { recursive: true })
  await writeFile(join(releaseRoot, 'browser/manifest.json'), `${JSON.stringify({ target: process.platform === 'linux' && process.arch === 'x64' ? 'linux-amd64' : `${process.platform}-${process.arch}`, executable: 'chromium/chrome' })}\n`)
  await writeFile(join(releaseRoot, 'browser/chromium/chrome'), 'fixture\n', { mode: 0o755 })
  return { root, releaseRoot, stateRoot }
}

test('production plan uses only sealed artifacts and loopback host services', async (t) => {
  const item = await fixture(t)
  const supplied = {
    OPENLINK_ZOKERBASE_ENV_FILE: join(item.root, 'zokerbase.env'),
    POSTGRES_PASSWORD: 'database-only-secret',
    OPENLINK_BROWSER_API_TOKEN: 'browser-api-secret',
    OPENLINK_BROWSER_TOKEN_SECRET: 'browser-token-secret',
    OPENLINK_AGENT_API_TOKEN: 'agent-api-secret',
    OPENLINK_DESKTOP_AGENT_API_TOKEN: 'desktop-api-secret',
    OPEN_SANDBOX_API_KEY: 'sandbox-api-secret',
    OPENLINK_PROVIDER_SECRET_KEY: 'provider-secret',
    OPENLINK_SUPABASE_SERVICE_ROLE_KEY: 'database-service-secret',
    OPENLINK_KNOWLEDGE_INTERNAL_TOKEN: 'knowledge-secret',
    OPENLINK_KNOWLEDGE_ZOKERBASE_SERVICE_KEY: 'knowledge-database-secret',
  }
  const plan = await createRuntimePlan({
    releaseRoot: item.releaseRoot,
    stateRoot: item.stateRoot,
    environment: supplied,
    validate: false,
  })
  assert.equal(plan.images.length, 3)
  assert.equal(plan.profile, 'standard')
  assert.equal(plan.projectRuntime, 'vm')
  assert.equal(plan.isolationClass, 'vm')
  assert.deepEqual(plan.processes.map((process) => process.name), ['browser-host', 'knowledge-service', 'agent-host', 'desktop-agent-host', 'web', 'edge'])
  assert.deepEqual(plan.processes.map((process) => process.identity), ['openlink-browser', 'openlink-knowledge', 'openlink-agent', 'openlink-desktop', 'openlink-web', 'openlink-edge'])
  assert.equal(plan.processes.at(-1).args.includes('--adapter'), true)
  assert.equal(plan.processes[0].environment.OPENLINK_CHROME_EXECUTABLE, join(item.releaseRoot, 'browser/chromium/chrome'))
  assert.equal(plan.processes.find((process) => process.name === 'web').healthUrl.endsWith('/api/healthz'), true)
  assert.equal(plan.processes[0].environment.OPENLINK_RELEASE_ID, 'release')
  assert.equal(plan.processes.filter((process) => process.name !== 'edge').every((process) => process.environment.OPENLINK_RUNTIME_MODE === 'local'), true)
  assert.equal(plan.processes.find((process) => process.name === 'agent-host').environment.OPENLINK_AGENT_HOST, '127.0.0.1')
  assert.equal(plan.processes.find((process) => process.name === 'web').environment.OPENLINK_AGENT_HOST_URL, 'http://127.0.0.1:43121')
  assert.equal(Object.keys(plan.processes.at(-1).environment).some((key) => /TOKEN|SECRET|PASSWORD|KEY/.test(key)), false)
  assert.equal(plan.compose.every((item) => item.args.includes('--pull') && item.args.includes('never')), true)
  const processes = Object.fromEntries(plan.processes.map((process) => [process.name, process.environment]))
  assert.equal(processes['browser-host'].OPENLINK_BROWSER_API_TOKEN, 'browser-api-secret')
  assert.equal(processes['browser-host'].POSTGRES_PASSWORD, undefined)
  assert.equal(processes['browser-host'].OPENLINK_AGENT_API_TOKEN, undefined)
  assert.equal(processes['agent-host'].OPENLINK_AGENT_API_TOKEN, 'agent-api-secret')
  assert.equal(processes['agent-host'].OPENLINK_SUPABASE_SERVICE_ROLE_KEY, 'database-service-secret')
  assert.equal(processes['agent-host'].OPENLINK_BROWSER_TOKEN_SECRET, undefined)
  assert.equal(processes['knowledge-service'].OPENLINK_KNOWLEDGE_ZOKERBASE_SERVICE_KEY, 'knowledge-database-secret')
  assert.equal(processes['knowledge-service'].OPEN_SANDBOX_API_KEY, undefined)
  assert.equal(processes['desktop-agent-host'].OPENLINK_DESKTOP_AGENT_API_TOKEN, 'desktop-api-secret')
  assert.equal(processes['desktop-agent-host'].OPENLINK_BROWSER_API_TOKEN, undefined)
  assert.equal(processes.web.OPENLINK_AGENT_API_TOKEN, 'agent-api-secret')
  assert.equal(processes.web.OPENLINK_BROWSER_TOKEN_SECRET, undefined)
  assert.equal(processes.web.POSTGRES_PASSWORD, undefined)
  assert.equal(plan.compose[0].environment.POSTGRES_PASSWORD, 'database-only-secret')
  assert.doesNotMatch(JSON.stringify(plan), /\b(?:npm|pnpm|yarn|tsc)\b|\b(?:build|pull)\b.*(?:source|registry)/i)
})

test('Core omits the built-in knowledge system independently from Project isolation', async (t) => {
  const item = await fixture(t)
  for (const projectRuntime of ['container', 'vm']) {
    const plan = await createRuntimePlan({
      releaseRoot: item.releaseRoot,
      stateRoot: item.stateRoot,
      environment: {
        OPENLINK_ZOKERBASE_ENV_FILE: join(item.root, 'zokerbase.env'),
        OPENLINK_DEPLOYMENT_PROFILE: 'core',
        OPENLINK_PROJECT_RUNTIME: projectRuntime,
      },
      validate: false,
    })
    assert.equal(plan.profile, 'core')
    assert.equal(plan.projectRuntime, projectRuntime)
    assert.equal(plan.processes.some((process) => process.name === 'knowledge-service'), false)
    assert.equal(plan.compose.some((compose) => compose.name === 'zero'), false)
    assert.equal(plan.images.some((image) => image.kind === 'zero'), false)
    assert.equal(plan.stateDirectories.includes('knowledge'), false)
    assert.equal(plan.stateDirectories.includes('zero'), false)
    const web = plan.processes.find((process) => process.name === 'web')
    assert.equal(web.environment.OPENLINK_KNOWLEDGE_ENABLED, '0')
    assert.equal(web.environment.OPENLINK_PROJECT_RUNTIME, projectRuntime)
  }
})

test('Standard and Dense retain knowledge with both Project backends', async (t) => {
  const item = await fixture(t)
  for (const deploymentProfile of ['standard', 'dense']) {
    for (const projectRuntime of ['container', 'vm']) {
      const plan = await createRuntimePlan({
        releaseRoot: item.releaseRoot,
        stateRoot: item.stateRoot,
        environment: {
          OPENLINK_ZOKERBASE_ENV_FILE: join(item.root, 'zokerbase.env'),
          OPENLINK_DEPLOYMENT_PROFILE: deploymentProfile,
          OPENLINK_PROJECT_RUNTIME: projectRuntime,
        },
        validate: false,
      })
      assert.equal(plan.processes.some((process) => process.name === 'knowledge-service'), true)
      assert.equal(plan.compose.some((compose) => compose.name === 'zero'), true)
      assert.equal(plan.isolationClass, projectRuntime === 'container' ? 'container' : 'vm')
      assert.equal(plan.projectRuntime, projectRuntime)
      assert.equal(plan.profile, deploymentProfile)
    }
  }
})

test('Linux root supervisor launches every network process under its dedicated kernel identity', () => {
  const base = { command: '/opt/openlink/current/runtime/node/bin/node', args: ['/opt/openlink/current/service.js'] }
  const web = isolatedProcessInvocation({ ...base, name: 'web', identity: 'openlink-web' }, { platform: 'linux', root: true })
  assert.equal(web.command, '/usr/bin/setpriv')
  assert.deepEqual(web.args.slice(0, 6), ['--reuid=openlink-web', '--regid=openlink-web', '--init-groups', '--inh-caps=-all', '--ambient-caps=-all', '--bounding-set=-all'])
  assert.equal(web.args.includes('--no-new-privs'), true)
  assert.equal(web.args.at(-2), base.command)
  const edge = isolatedProcessInvocation({ ...base, name: 'edge', identity: 'openlink-edge' }, { platform: 'linux', root: true })
  assert.equal(edge.args.includes('--ambient-caps=+net_bind_service'), true)
  assert.equal(edge.args.includes('--bounding-set=-all,+net_bind_service'), true)
  assert.throws(() => isolatedProcessInvocation({ ...base, name: 'web', identity: 'openlink-agent' }, { platform: 'linux', root: true }), /identity is invalid/i)
})

test('supervisor starts dependencies in order and shuts down application before data stores', async (t) => {
  const item = await fixture(t)
  const events = []
  const children = []
  let forcedImageMismatch = true
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
    runCommand: async (_command, args) => {
      events.push(`command:${args.join(' ')}`)
      if (!args.includes('inspect')) return ''
      if (forcedImageMismatch) { forcedImageMismatch = false; return `sha256:${'b'.repeat(64)}\n` }
      return `sha256:${'a'.repeat(64)}\n`
    },
    spawnProcess: (_command, _args, options) => {
      assert.ok(options.env)
      assert.equal(options.environment, undefined)
      events.push(`spawn:${options.openlinkName}`)
      return childFor(options.openlinkName)
    },
    probe: async (url) => { events.push(`probe:${url}`); return true },
    notifyReady: async () => { events.push('ready') },
  })
  await supervisor.start()
  assert.equal(events.at(-1), 'ready')
  assert.equal(events.some((event) => event.startsWith('command:load --input')), true)
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
    runCommand: async (_command, args) => args.includes('inspect') ? `sha256:${'a'.repeat(64)}\n` : '',
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

test('runtime lock status fails closed on corrupt owner metadata', async (t) => {
  const item = await fixture(t)
  const lockRoot = join(item.stateRoot, 'run/runtime.lock')
  await mkdir(lockRoot, { recursive: true })
  await writeFile(join(lockRoot, 'owner.json'), '{not-json\n')
  await assert.rejects(runtimeLockStatus(item.stateRoot), /JSON|position|property/i)
  await assert.rejects(acquireRuntimeLock(item.stateRoot), /JSON|position|property/i)
})
