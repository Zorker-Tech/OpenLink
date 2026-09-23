import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const exports = {}
new Function('exports', ts.transpileModule(readFileSync(new URL('../../lib/agent-runtime/message-revisions.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(exports)
const user = (id, text, revision = false) => ({ type: 'message.user', id: revision ? `${id}:revision` : id, messageId: id, text, ...(revision ? { replacesMessageId: id } : {}) })

test('editing preserves message identity and replaces descendants without mutating the journal', () => {
  const events = [user('one', 'first'), { type: 'message.completed', id: 'answer' }, user('two', 'second'), user('one', 'edited', true)]
  assert.deepEqual(exports.projectMessageRevisions(events), [user('one', 'edited', true)])
  assert.equal(events.length, 4)
})
test('later message edits preserve all preceding conversation and survive another replay', () => {
  const prefix = [user('one', 'first'), { type: 'message.completed', id: 'answer' }]
  const revision = user('two', 'edited', true)
  const projected = exports.projectMessageRevisions([...prefix, user('two', 'second'), revision])
  assert.deepEqual(projected, [...prefix, revision])
  assert.deepEqual(exports.projectMessageRevisions(projected), projected)
})
test('message edit is inline and session command buttons are absent', () => {
  const timeline = readFileSync(new URL('../../components/chat-timeline.tsx', import.meta.url), 'utf8')
  const workspace = readFileSync(new URL('../../components/chat-workspace.tsx', import.meta.url), 'utf8')
  assert.match(timeline, /aria-label=\{t\('编辑原消息'\)\}/)
  assert.match(timeline, /mx-auto.*border-dashed/)
  assert.match(timeline, /if \(!editing && restoreFocus\.current\)[\s\S]*trigger\.current\?\.focus\(\)/)
  assert.match(timeline, /<MessageResponse key=\{item\.id\}/)
  assert.doesNotMatch(timeline + workspace, /openlink:edit-message|编辑并重发|aria-label="Agent 会话控制"/)
  assert.match(workspace, /goal-clear\|goal\|plan\|default\|compact\|pause\|resume\|interrupt\|steer/)
})
