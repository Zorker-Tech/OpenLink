import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeModelCost, normalizeModelParams } from '../../lib/provider-model-params.ts'

test('negative catalog price sentinels normalize to zero', () => {
  assert.deepEqual(normalizeModelCost({ input: -1, output: -1, cacheRead: -0.5, cacheWrite: -2 }), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  })
})

test('normal costs and optional cache fields survive normalization', () => {
  assert.deepEqual(normalizeModelCost({ input: 1.25, output: 10, cacheRead: 0.125 }), {
    input: 1.25,
    output: 10,
    cacheRead: 0.125,
  })
})

test('invalid token bounds fall back instead of blocking a save', () => {
  const params = normalizeModelParams({
    name: '',
    reasoning: true,
    input: ['text', 'audio', 'image'],
    contextWindow: 0,
    maxTokens: -1,
    cost: { input: -1000000, output: -1000000 },
  }, 'openrouter/auto')
  assert.equal(params.name, 'openrouter/auto')
  assert.equal(params.reasoning, true)
  assert.deepEqual(params.input, ['text', 'image'])
  assert.equal(params.contextWindow, 128_000)
  assert.equal(params.maxTokens, 8_192)
  assert.deepEqual(params.cost, { input: 0, output: 0 })
})

test('out-of-range catalog values are clamped to the settings bounds', () => {
  const params = normalizeModelParams({
    name: 'x'.repeat(300),
    reasoning: false,
    input: ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text'],
    contextWindow: 200_000_000,
    maxTokens: 200_000_000,
    cost: { input: 2_000_000, output: 2_000_000 },
  }, 'fallback')
  assert.equal(params.name.length, 256)
  assert.equal(params.input.length, 8)
  assert.equal(params.contextWindow, 100_000_000)
  assert.equal(params.maxTokens, 100_000_000)
  assert.deepEqual(params.cost, { input: 1_000_000, output: 1_000_000 })
})

test('valid parameters are preserved exactly', () => {
  const input = {
    name: 'Claude Sonnet',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 200_000,
    maxTokens: 64_000,
    cost: { input: 3, output: 15 },
  }
  assert.deepEqual(normalizeModelParams(input, 'fallback'), input)
})
