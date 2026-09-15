import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../../components/chat-confirmation-dock.tsx', import.meta.url), 'utf8')

test('approval actions use explicit refuse and allow semantics', () => {
  assert.match(source, /confirmationKind === 'approval' \? '拒绝' : '跳过'/)
  assert.match(source, /confirmationKind === 'approval' \? '允许' : '提交'/)
})

test('questions preserve native order and selects have no disabled submit action', () => {
  assert.match(source, /className="relative z-10 mx-\[21px\] flex flex-col gap-1"/)
  assert.doesNotMatch(source, /flex-col-reverse/)
  assert.match(source, /request\.inputKind !== 'select' \? <button/)
})

test('failed responses remain in flow and expose retry feedback', () => {
  assert.match(source, /role="alert">\{errors\[request\.id\]\}/)
  assert.doesNotMatch(source, /absolute left-10 top-full/)
})
