import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  codexPluginMentionName,
  codexPluginToken,
  codexSkillToken,
  piSkillToken,
  promptTriggerAt,
  replacePromptTrigger,
} from '../../lib/prompt-input-protocol.ts'

test('formats menu selections as native Agent tokens instead of prose prompts', () => {
  assert.equal(codexSkillToken('figma'), '$figma ')
  assert.equal(codexPluginMentionName('computer-use', 'Computer Use'), 'Computer-Use')
  assert.equal(codexPluginMentionName('browser', 'Browser'), 'Browser')
  assert.equal(codexPluginToken('browser', 'Browser'), '@Browser ')
  assert.equal(piSkillToken('release-notes'), '/skill:release-notes ')
})

test('Codex MCP inventory remains a read-only status surface', () => {
  const menu = readFileSync(new URL('../../components/prompt-add-menu.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(menu, /mcp verbose|codexMcpInventoryToken/)
  assert.match(menu, /MCP 状态为只读/)
  assert.match(menu, /disabled=\{agent === 'codex'\}/)
})

test('desktop commands can occur inline while line-only agents retain their own boundary', () => {
  assert.deepEqual(promptTriggerAt('/rev', 4), { kind: 'command', query: 'rev', start: 0, end: 4 })
  assert.deepEqual(promptTriggerAt('please /rev', 11), { kind: 'command', query: 'rev', start: 7, end: 11 })
  assert.equal(promptTriggerAt('please /rev', 11, { lineStartOnly: true }), null)
  assert.equal(promptTriggerAt('https://example.com', 19), null)
})

test('keeps a native slash command drawer active while filtering its children', () => {
  assert.deepEqual(promptTriggerAt('/skills fig', 11), {
    kind: 'command',
    command: 'skills',
    query: 'fig',
    start: 8,
    end: 11,
  })
  assert.deepEqual(promptTriggerAt('first\n/plugins ', 15), {
    kind: 'command',
    command: 'plugins',
    query: '',
    start: 15,
    end: 15,
  })
})

test('detects project file mentions at the caret', () => {
  assert.deepEqual(promptTriggerAt('review @src/app', 15), { kind: 'mention', query: 'src/app', start: 7, end: 15 })
  assert.equal(promptTriggerAt('mail@example.com', 16), null)
})

test('actions and inline prompt arguments never become resource submenus', () => {
  for (const text of ['/compact ', '/plan ', '/plan explain this', '/goal finish the task', '/steer change direction', '/unknown anything']) {
    assert.equal(promptTriggerAt(text, text.length), null, text)
  }
  assert.equal(promptTriggerAt('/plan review @src/app', 21)?.kind, 'mention')
})

test('detects Codex native skill invocation at the caret', () => {
  assert.deepEqual(promptTriggerAt('use $frontend', 13), { kind: 'skill', query: 'frontend', start: 4, end: 13 })
})

test('replaces only the active prompt token', () => {
  const trigger = promptTriggerAt('review @src/ap now', 14)
  assert.ok(trigger)
  assert.deepEqual(replacePromptTrigger('review @src/ap now', trigger, '@src/app.ts '), {
    value: 'review @src/app.ts  now',
    cursor: 19,
  })
})
