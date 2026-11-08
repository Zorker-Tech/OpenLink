import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createEmptyWorkspacePreviewState,
  loadWorkspacePreviewState,
  sanitizeWorkspacePreviewState,
  saveWorkspacePreviewState,
} from '../../lib/workspace-preview-state.mjs'

const userId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const workspaceId = '11111111-2222-4333-8444-555555555555'
const projectA = '99999999-8888-4777-8666-555555555555'
const projectB = '22222222-3333-4444-8555-666666666666'
const targetA = 'A'.repeat(43)
const targetB = 'B'.repeat(43)

class MemoryStorage {
  values = new Map()

  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, String(value)) }
}

test('stores Preview project and target preference by user and workspace, not chat', () => {
  const storage = new MemoryStorage()
  const state = { version: 3, selectedProjectId: projectB, targetIds: { [projectA]: targetA, [projectB]: targetB }, pagePaths: { [targetA]: '/settings', [targetB]: '/dashboard' }, viewportModes: { [targetA]: 'mobile', [targetB]: 'browser' } }

  assert.equal(saveWorkspacePreviewState(userId, workspaceId, state, [projectA, projectB], storage), true)
  assert.deepEqual(loadWorkspacePreviewState(userId, workspaceId, [projectA, projectB], storage), state)
  assert.equal(loadWorkspacePreviewState(userId, '33333333-4444-4555-8666-777777777777', [projectA, projectB], storage), null)
})

test('drops unauthorized projects and malformed target IDs when restoring local state', () => {
  const state = sanitizeWorkspacePreviewState({
    version: 999,
    selectedProjectId: projectB,
    targetIds: { [projectA]: targetA, [projectB]: 'not-an-opaque-target', '../../etc/passwd': targetB },
    pagePaths: { [targetA]: '/settings', [targetB]: '/dashboard', ['C'.repeat(43)]: '/unbound', [targetA + 'x']: '//external.example', ['D'.repeat(43)]: '/private?token=secret' },
    viewportModes: { [targetA]: 'mobile', [targetB]: 'browser', ['C'.repeat(43)]: 'mobile', [targetA + 'x']: 'tablet' },
  }, [projectA])

  assert.deepEqual(state, { version: 3, selectedProjectId: null, targetIds: { [projectA]: targetA }, pagePaths: { [targetA]: '/settings' }, viewportModes: { [targetA]: 'mobile' } })
})

test('migrates the prior project and target preference to the route-aware state version', () => {
  const storage = new MemoryStorage()
  storage.setItem('openlink:workspace-preview:v1:' + userId + ':' + workspaceId, JSON.stringify({
    version: 1,
    selectedProjectId: projectA,
    targetIds: { [projectA]: targetA },
  }))

  assert.deepEqual(loadWorkspacePreviewState(userId, workspaceId, [projectA], storage), {
    version: 3,
    selectedProjectId: projectA,
    targetIds: { [projectA]: targetA },
    pagePaths: {},
    viewportModes: {},
  })
})

test('preserves route preferences while migrating the route-aware state to target-specific viewports', () => {
  const storage = new MemoryStorage()
  storage.setItem('openlink:workspace-preview:v2:' + userId + ':' + workspaceId, JSON.stringify({
    version: 2,
    selectedProjectId: projectA,
    targetIds: { [projectA]: targetA },
    pagePaths: { [targetA]: '/details' },
  }))

  assert.deepEqual(loadWorkspacePreviewState(userId, workspaceId, [projectA], storage), {
    version: 3,
    selectedProjectId: projectA,
    targetIds: { [projectA]: targetA },
    pagePaths: { [targetA]: '/details' },
    viewportModes: {},
  })
})

test('recovers the prior version when the current browser-profile value is corrupt', () => {
  const storage = new MemoryStorage()
  storage.setItem('openlink:workspace-preview:v3:' + userId + ':' + workspaceId, '{')
  storage.setItem('openlink:workspace-preview:v1:' + userId + ':' + workspaceId, JSON.stringify({
    version: 1,
    selectedProjectId: projectA,
    targetIds: { [projectA]: targetA },
  }))

  assert.deepEqual(loadWorkspacePreviewState(userId, workspaceId, [projectA], storage), {
    version: 3,
    selectedProjectId: projectA,
    targetIds: { [projectA]: targetA },
    pagePaths: {},
    viewportModes: {},
  })
})

test('handles unavailable or corrupt local storage without breaking Preview', () => {
  const unavailable = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
  const corrupt = new MemoryStorage()
  corrupt.setItem('openlink:workspace-preview:v1:' + userId + ':' + workspaceId, '{')

  assert.deepEqual(createEmptyWorkspacePreviewState(), { version: 3, selectedProjectId: null, targetIds: {}, pagePaths: {}, viewportModes: {} })
  assert.equal(loadWorkspacePreviewState(userId, workspaceId, [projectA], unavailable), null)
  assert.equal(saveWorkspacePreviewState(userId, workspaceId, createEmptyWorkspacePreviewState(), [projectA], unavailable), false)
  assert.equal(loadWorkspacePreviewState(userId, workspaceId, [projectA], corrupt), null)
})
