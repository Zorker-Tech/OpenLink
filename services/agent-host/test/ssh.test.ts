import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRemoteProjectVmBootstrapPlan } from '../src/ssh.js'

test('builds a remote Project VM plan without a host container runtime', () => {
  const plan = buildRemoteProjectVmBootstrapPlan({
    id: 'prod-1',
    host: 'target.example.com',
    user: 'openlink',
    port: 22,
    remoteRoot: '/var/lib/openlink-agent',
  }, 'release-1', 'a'.repeat(64))
  assert.equal(plan.steps[1]?.id, 'preflight-kvm')
  assert.equal(plan.steps[3]?.command.executable, 'scp')
  assert.equal(plan.steps.at(-1)?.id, 'verify-project-vm-helper')
  assert.ok(plan.steps.some((step) => step.id === 'extract-bundle'))
  assert.ok(plan.steps.every((step) => !step.command.args.includes('docker')))
  assert.ok(plan.steps.every((step) => !step.command.args.includes('compose')))
  assert.ok(plan.steps.some((step) => step.command.args.some((arg) => arg.endsWith('/bundle.tar.gz'))))
  assert.ok(plan.steps.some((step) => step.command.executable === 'ssh'))
})

test('rejects unsafe SSH targets and digests', () => {
  assert.throws(() => buildRemoteProjectVmBootstrapPlan({
    id: 'prod 1',
    host: 'target.example.com',
    user: 'openlink',
    port: 22,
    remoteRoot: '/var/lib/openlink-agent',
  }, 'release-1', 'a'.repeat(64)))
  assert.throws(() => buildRemoteProjectVmBootstrapPlan({
    id: 'prod-1',
    host: 'target.example.com',
    user: 'openlink',
    port: 22,
    remoteRoot: '/var/lib/openlink-agent',
  }, 'release-1', 'not-a-digest'))
  assert.throws(() => buildRemoteProjectVmBootstrapPlan({
    id: 'prod-1',
    host: '-oProxyCommand=evil',
    user: 'openlink',
    port: 22,
    remoteRoot: '/var/lib/openlink-agent',
  }, 'release-1', 'a'.repeat(64)))
  assert.throws(() => buildRemoteProjectVmBootstrapPlan({
    id: 'prod-1',
    host: 'target.example.com',
    user: 'openlink',
    port: 22,
    remoteRoot: '/var/lib/openlink-agent;touch-pwned',
  }, 'release-1', 'a'.repeat(64)))
})
