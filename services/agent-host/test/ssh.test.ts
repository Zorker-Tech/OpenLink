import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRemoteBootstrapPlan } from '../src/ssh.js'

test('builds a remote plan with argv-safe commands', () => {
  const plan = buildRemoteBootstrapPlan({
    id: 'prod-1',
    host: 'target.example.com',
    user: 'openlink',
    port: 22,
    remoteRoot: '/var/lib/openlink-agent',
  }, 'release-1', 'a'.repeat(64))
  assert.equal(plan.steps[1]?.command.args.at(-1), '{{.ServerVersion}}')
  assert.equal(plan.steps[3]?.command.executable, 'scp')
  assert.equal(plan.steps.at(-1)?.requiresPrivilege, true)
  assert.ok(plan.steps.some((step) => step.id === 'extract-bundle'))
  assert.ok(plan.steps.some((step) => step.id === 'load-images'))
  assert.ok(plan.steps.some((step) => step.id === 'upload-secrets'))
  assert.ok(plan.steps.some((step) => step.id === 'protect-secrets'))
  assert.ok(plan.steps.some((step) => step.command.args.includes('runtime.env')))
  assert.ok(plan.steps.some((step) => step.command.args.some((arg) => arg.endsWith('/bundle.tar.gz'))))
  assert.ok(plan.steps.some((step) => step.command.executable === 'ssh'))
})

test('rejects unsafe SSH targets and digests', () => {
  assert.throws(() => buildRemoteBootstrapPlan({
    id: 'prod 1',
    host: 'target.example.com',
    user: 'openlink',
    port: 22,
    remoteRoot: '/var/lib/openlink-agent',
  }, 'release-1', 'a'.repeat(64)))
  assert.throws(() => buildRemoteBootstrapPlan({
    id: 'prod-1',
    host: 'target.example.com',
    user: 'openlink',
    port: 22,
    remoteRoot: '/var/lib/openlink-agent',
  }, 'release-1', 'not-a-digest'))
  assert.throws(() => buildRemoteBootstrapPlan({
    id: 'prod-1',
    host: '-oProxyCommand=evil',
    user: 'openlink',
    port: 22,
    remoteRoot: '/var/lib/openlink-agent',
  }, 'release-1', 'a'.repeat(64)))
  assert.throws(() => buildRemoteBootstrapPlan({
    id: 'prod-1',
    host: 'target.example.com',
    user: 'openlink',
    port: 22,
    remoteRoot: '/var/lib/openlink-agent;touch-pwned',
  }, 'release-1', 'a'.repeat(64)))
})
