import assert from 'node:assert/strict'
import test from 'node:test'

import { selectProjectRuntime } from '../../deploy/self-hosted/runtime/runtime-selection.mjs'

const ready = { required: true, status: 'ready', code: 'KVM_READY', provider: 'qemu-kvm', repairable: false }
const repairable = { required: true, status: 'repairable', code: 'KVM_MODULES_INACTIVE', provider: 'qemu-kvm', repairable: true, message: 'inactive' }
const unsupported = { required: true, status: 'nested-unavailable', code: 'NESTED_VIRTUALIZATION_UNAVAILABLE', provider: 'qemu-kvm', repairable: false, message: 'nested unavailable' }

test('selection keeps profile-independent concrete backends', async () => {
  assert.equal((await selectProjectRuntime({ requestedRuntime: 'container', detect: async () => ({ required: false, status: 'not-required', code: 'CONTAINER_RUNTIME_SELECTED', provider: 'docker', repairable: false }) })).runtime, 'container')
  assert.equal((await selectProjectRuntime({ requestedRuntime: 'auto', detect: async () => ready })).runtime, 'vm')
  assert.equal((await selectProjectRuntime({ requestedRuntime: 'vm', detect: async () => ready })).runtime, 'vm')
})

test('non-interactive VM startup fails closed unless Container is explicitly acknowledged', async () => {
  await assert.rejects(selectProjectRuntime({ requestedRuntime: 'vm', detect: async () => unsupported }), /NESTED_VIRTUALIZATION_UNAVAILABLE/)
  await assert.rejects(selectProjectRuntime({ requestedRuntime: 'vm', policy: 'container', detect: async () => unsupported }), /acknowledge-isolation-downgrade/)
  const selected = await selectProjectRuntime({ requestedRuntime: 'vm', policy: 'container', acknowledgeIsolationDowngrade: true, detect: async () => unsupported })
  assert.equal(selected.runtime, 'container')
  assert.equal(selected.action, 'container-selected')
})

test('repair policy enables KVM only for repairable results', async () => {
  let enabled = false
  const selected = await selectProjectRuntime({ requestedRuntime: 'vm', policy: 'enable', detect: async () => repairable, enable: async () => { enabled = true; return ready } })
  assert.equal(enabled, true)
  assert.equal(selected.runtime, 'vm')
  await assert.rejects(selectProjectRuntime({ requestedRuntime: 'vm', policy: 'enable', detect: async () => unsupported }), /nested unavailable/)
})

test('interactive selection supports help, activation, Container, and exit', async () => {
  const shown = []
  const answers = ['help', 'enable']
  const enabled = await selectProjectRuntime({
    requestedRuntime: 'vm', interactive: true, detect: async () => repairable,
    prompt: async ({ choices }) => { assert.deepEqual(choices, ['enable', 'container', 'help', 'exit']); return answers.shift() },
    showHelp: async (help) => shown.push(help.code), enable: async () => ready,
  })
  assert.deepEqual(shown, ['KVM_MODULES_INACTIVE'])
  assert.equal(enabled.runtime, 'vm')
  const container = await selectProjectRuntime({ requestedRuntime: 'vm', interactive: true, detect: async () => unsupported, prompt: async () => 'container' })
  assert.equal(container.runtime, 'container')
  await assert.rejects(selectProjectRuntime({ requestedRuntime: 'vm', interactive: true, detect: async () => unsupported, prompt: async () => 'exit' }), /cancelled/)
})
