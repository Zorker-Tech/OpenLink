import assert from 'node:assert/strict'
import test from 'node:test'
import { compileSandboxPolicy } from '../src/policy.js'
import { createSessionStorageLayout } from '../src/storage.js'

const policy = {
  allowedDomains: ['api.example.com'],
  deniedDomains: [],
  allowWrite: [],
  denyWrite: [],
  denyRead: [],
  allowUnixSockets: [],
}

test('creates deterministic per-session storage without path traversal', () => {
  const layout = createSessionStorageLayout('/tmp/openlink', 'user-1', 'workspace-1', 'session-1')
  assert.equal(layout.piSessions, '/tmp/openlink/user-1/workspace-1/session-1/pi-sessions')
  assert.throws(() => createSessionStorageLayout('/tmp/openlink', '../user', 'workspace-1', 'session-1'))
})

test('compiles an allow-only write policy and default credential denies', () => {
  const compiled = compileSandboxPolicy('/tmp/openlink/workspace', '/tmp/openlink/storage', policy)
  assert.deepEqual(compiled.network.allowedDomains, ['api.example.com'])
  assert.deepEqual(compiled.filesystem.allowWrite, ['/tmp/openlink/workspace', '/tmp/openlink/storage'])
  assert.ok(compiled.filesystem.denyWrite.includes('.env'))
  assert.ok(compiled.filesystem.denyRead.includes('~/.ssh'))
})

test('rejects write roots outside the workspace and storage roots', () => {
  assert.throws(() => compileSandboxPolicy('/tmp/openlink/workspace', '/tmp/openlink/storage', {
    ...policy,
    allowWrite: ['/tmp/other'],
  }))
})
