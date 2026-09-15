import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../../components/workspace-prompt.tsx', import.meta.url), 'utf8')
test('the prompt stays visually empty instead of carrying runtime status text', () => {
  assert.match(source, /<AgentPromptTextarea[\s\S]*placeholder=""[\s\S]*<\/PromptInputBody>/)
  assert.doesNotMatch(source, /现在我们做些什么|workspace-runtime-hint|runtimeHintId|aria-describedby/)
  assert.doesNotMatch(source, /查看状态详情|查看最近一次错误|尚未开始尝试/)
})

test('runtime readiness gates submission without adding prompt hints', () => {
  assert.match(source, /disabled=\{!runtimeReady\}/)
  assert.match(source, /if \(!runtimeReady\)/)
  assert.match(source, /window.setInterval\(refresh, 2_500\)/)
})
