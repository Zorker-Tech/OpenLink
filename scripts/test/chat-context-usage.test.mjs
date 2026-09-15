import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const compiled = ts.transpileModule(readFileSync(new URL('../../lib/chat-session-persistence.server.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const exports = {}
new Function('require', 'exports', compiled)(() => ({}), exports)
function database(entries, payload) {
  const query = {
    schema() { return this }, from(name) { this.table = name; return this }, select() { return this },
    eq() { return this }, order() { return this }, limit() { return this },
    range: async () => ({ data: entries.map(entry => ({ entry })), error: null }),
    maybeSingle: async () => ({ data: payload ? { payload } : null, error: null }),
  }
  return query
}
test('Pi counts caches once and separates current context from cumulative consumption', async () => {
  const db = database([1, 2].map(() => ({ type: 'message', message: { role: 'assistant', model: 'test', usage: { input: 100, cacheRead: 20, cacheWrite: 10, output: 40, reasoning: 15 } } })))
  const usage = await exports.loadSessionContextUsage(db, 'u', 's', 'pi')
  assert.equal(usage.totalTokens, 340)
  assert.equal(usage.inputTokens, 260)
  assert.equal(usage.contextTokens, 170)
})
test('Codex reads native usage events rather than Pi entries', async () => {
  const db = database([], { type: 'usage.updated', inputTokens: 400, outputTokens: 100, totalTokens: 500, cachedInputTokens: 200, reasoningTokens: 50, contextTokens: 150, contextWindow: 128000 })
  const usage = await exports.loadSessionContextUsage(db, 'u', 's', 'codex')
  assert.equal(db.table, 'chat_session_events')
  assert.equal(usage.totalTokens, 500)
  assert.equal(usage.contextTokens, 150)
})
test('unreported and post-compaction occupancy remain unknown', async () => {
  assert.equal((await exports.loadSessionContextUsage(database([]), 'u', 's', 'codex')).contextTokens, null)
  const entries = [{ type: 'message', message: { role: 'assistant', usage: { input: 100, output: 1 } } }, { type: 'compaction' }]
  assert.equal((await exports.loadSessionContextUsage(database(entries), 'u', 's', 'pi')).contextTokens, null)
  entries.push({ type: 'message', message: { role: 'assistant', usage: { input: 0, output: 0 } } })
  const canceled = await exports.loadSessionContextUsage(database(entries), 'u', 's', 'pi')
  assert.equal(canceled.contextTokens, null)
  assert.equal(canceled.totalTokens, 101)
})
