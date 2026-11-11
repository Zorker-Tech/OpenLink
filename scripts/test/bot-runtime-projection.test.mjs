import assert from 'node:assert/strict'
import test from 'node:test'

import { decideBotProjectionRecovery } from '../../lib/bot-runtime-projection.ts'

const bot = {
  userId: 'user-1',
  workspaceId: 'workspace-1',
  runtimeSessionId: 'BotSession1',
  projectId: 'project-1',
}

function session(overrides = {}) {
  return {
    id: 'BotSession1',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    surface: 'bot',
    ...overrides,
  }
}

function project(overrides = {}) {
  return { id: 'project-1', workspaceId: 'workspace-1', ...overrides }
}

test('a valid Bot session and Project are reused without writes', () => {
  assert.deepEqual(decideBotProjectionRecovery(bot, { session: session(), project: project() }), {
    action: 'reuse',
    recreateSession: false,
    repairSession: false,
    recreateProject: false,
  })
})

test('a missing Bot session is recreated while its Project remains authoritative', () => {
  assert.deepEqual(decideBotProjectionRecovery(bot, { session: null, project: project() }), {
    action: 'recreate-session',
    recreateSession: true,
    repairSession: false,
    recreateProject: false,
  })
})

test('a missing Project preserves the Bot session and repoints it at a new Project', () => {
  assert.deepEqual(decideBotProjectionRecovery(bot, { session: session(), project: null }), {
    action: 'recreate-project',
    recreateSession: false,
    repairSession: true,
    recreateProject: true,
  })
})

test('a Code-mode session is never adopted as a Bot execution session', () => {
  assert.deepEqual(decideBotProjectionRecovery(bot, {
    session: session({ surface: 'code' }),
    project: project(),
  }), {
    action: 'recreate-session',
    recreateSession: true,
    repairSession: false,
    recreateProject: false,
  })
})

test('a session owned by another user or workspace is not reused', () => {
  assert.equal(decideBotProjectionRecovery(bot, {
    session: session({ userId: 'user-2' }),
    project: project(),
  }).action, 'recreate-session')
  assert.equal(decideBotProjectionRecovery(bot, {
    session: session({ workspaceId: 'workspace-2' }),
    project: project(),
  }).action, 'recreate-session')
})

test('a Project from another workspace is replaced while the Bot session is preserved', () => {
  assert.deepEqual(decideBotProjectionRecovery(bot, {
    session: session(),
    project: project({ workspaceId: 'workspace-2' }),
  }), {
    action: 'recreate-project',
    recreateSession: false,
    repairSession: true,
    recreateProject: true,
  })
})

test('a session that points at a different Project is repaired in place', () => {
  assert.deepEqual(decideBotProjectionRecovery(bot, {
    session: session({ projectId: 'project-2' }),
    project: project(),
  }), {
    action: 'repair-session',
    recreateSession: false,
    repairSession: true,
    recreateProject: false,
  })
})

test('a Bot without a runtime session or Project requires a full projection rebuild', () => {
  assert.deepEqual(decideBotProjectionRecovery({
    ...bot,
    runtimeSessionId: null,
    projectId: null,
  }, { session: null, project: null }), {
    action: 'rebuild-both',
    recreateSession: true,
    repairSession: false,
    recreateProject: true,
  })
})

test('a Code-mode session is never repaired or adopted even when the Project is missing', () => {
  assert.deepEqual(decideBotProjectionRecovery(bot, {
    session: session({ surface: 'code' }),
    project: null,
  }), {
    action: 'rebuild-both',
    recreateSession: true,
    repairSession: false,
    recreateProject: true,
  })
})
