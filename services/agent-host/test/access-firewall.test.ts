import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifySql,
  createFirewallConfirmation,
  DEFAULT_ACCESS_MODE,
  evaluateFirewall,
  evaluateSqlFirewall,
  isAccessMode,
  normalizeAccessMode,
} from '../src/access-firewall.js'

const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'
const sessionId = 'BmjZy32Zjqj'

test('normalizes unknown values to the safe default', () => {
  assert.equal(normalizeAccessMode('open'), 'open')
  assert.equal(normalizeAccessMode('ASK'), 'ask')
  assert.equal(normalizeAccessMode('nonsense'), DEFAULT_ACCESS_MODE)
  assert.equal(normalizeAccessMode(undefined), DEFAULT_ACCESS_MODE)
  assert.equal(isAccessMode('open'), true)
  assert.equal(isAccessMode('nonsense'), false)
})

test('classifies read, write, multi and invalid statements', () => {
  assert.equal(classifySql('select * from t').kind, 'read')
  assert.equal(classifySql('with x as (select 1) select * from x').kind, 'read')
  assert.equal(classifySql('explain select 1').kind, 'read')
  assert.equal(classifySql('insert into t values (1)').kind, 'write')
  assert.equal(classifySql('drop table auth.users').kind, 'write')
  assert.equal(classifySql('create table t (id int)').kind, 'write')
  assert.equal(classifySql('select 1; drop table t').kind, 'write', 'multi-statement with a write is a write')
  assert.equal(classifySql('select 1; select 2').kind, 'multi')
  assert.equal(classifySql('   ').kind, 'invalid')
  assert.equal(classifySql('x'.repeat(13_000)).kind, 'invalid')
})

test('firewall decision matrix for the three modes', () => {
  const read = evaluateFirewall('restricted', 'read')
  assert.equal(read.decision, 'allow')
  assert.equal(evaluateFirewall('ask', 'read').decision, 'allow')
  assert.equal(evaluateFirewall('open', 'read').decision, 'allow')

  assert.equal(evaluateFirewall('restricted', 'write').decision, 'deny')
  assert.equal(evaluateFirewall('ask', 'write').decision, 'require-confirmation')
  assert.equal(evaluateFirewall('open', 'write').decision, 'allow', 'open mode must not restrict anything')

  assert.equal(evaluateFirewall('restricted', 'multi').decision, 'deny')
  assert.equal(evaluateFirewall('ask', 'multi').decision, 'require-confirmation')
  assert.equal(evaluateFirewall('open', 'multi').decision, 'allow')

  assert.equal(evaluateFirewall('open', 'invalid').decision, 'deny', 'invalid sql is denied even in open mode')
})

test('evaluateSqlFirewall returns the classification with the decision', () => {
  const result = evaluateSqlFirewall('restricted', 'drop table auth.users')
  assert.equal(result.decision, 'deny')
  assert.equal(result.classification.kind, 'write')
})

test('confirmations are project/session/sql-bound and expire', () => {
  const confirmation = createFirewallConfirmation({
    projectId, sessionId, mode: 'ask', operation: 'query', sql: 'create table t (id int)', ttlMs: 1_000, now: 1_000,
  })
  assert.equal(confirmation.projectId, projectId)
  assert.equal(confirmation.sessionId, sessionId)
  assert.ok(confirmation.expiresAt > 1_000)
  assert.notEqual(confirmation.id, createFirewallConfirmation({
    projectId, sessionId, mode: 'ask', operation: 'query', sql: 'create table t (id int)', ttlMs: 1_000, now: 1_000,
  }).id, 'ids must be unique')
})
