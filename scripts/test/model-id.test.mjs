import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { MODEL_ID_PATTERN, isValidModelId } from '../../lib/model-id.ts'

test('accepts the punctuation styles used by provider catalogs', () => {
  const ids = [
    'openai/gpt-5.2-codex',
    'anthropic/claude-sonnet-4-5',
    'particle-ai/particle-1:free',
    '@cf/meta/llama-3.1-8b-instruct',
    '~anthropic/claude-sonnet-latest',
    'anthropic.claude-3-5-sonnet-20240620-v1:0',
    'accounts/fireworks/models/llama-v3p3-70b-instruct',
    'llama3.2:latest',
    'deepseek/deepseek-v4.1-flash-1017',
  ]
  for (const id of ids) assert.equal(isValidModelId(id), true, id)
})

test('rejects unsafe identifiers', () => {
  const ids = [
    '',
    ' model',
    'model ',
    'model\nid',
    'model\u0000id',
    '../escape',
    '/absolute',
    '.hidden',
    'x'.repeat(257),
  ]
  for (const id of ids) assert.equal(isValidModelId(id), false, JSON.stringify(id))
})

test('every bundled OpenRouter catalog id passes validation', async () => {
  const source = await readFile(
    new URL('../../services/pi/packages/ai/src/providers/data/openrouter.json', import.meta.url),
    'utf8',
  )
  const catalog = JSON.parse(source)
  const ids = Object.values(catalog)
    .flatMap((group) => Object.values(group))
    .map((model) => model.id)
    .filter((id) => typeof id === 'string')
  assert.ok(ids.length > 0)
  const rejected = ids.filter((id) => !MODEL_ID_PATTERN.test(id))
  assert.deepEqual(rejected, [])
  assert.ok(ids.some((id) => id.startsWith('~')), 'catalog should cover alias-prefixed ids')
})
