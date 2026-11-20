import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isolationClass,
  listDeploymentProfiles,
  profileEnvironment,
  resolveDeploymentProfile,
  resolveProjectRuntime,
} from '../../deploy/self-hosted/runtime/deployment-profile.mjs'

test('deployment profiles expose versioned component and resource contracts', () => {
  const [lite, core, standard, dense] = listDeploymentProfiles()
  assert.equal(lite.name, 'lite')
  assert.deepEqual(lite.components, { knowledge: false, zero: false })
  assert.equal(core.name, 'core')
  assert.deepEqual(core.components, { knowledge: false, zero: false })
  assert.deepEqual(standard.components, { knowledge: true, zero: true })
  assert.deepEqual(dense.components, { knowledge: true, zero: true })
  assert.deepEqual([lite.host.logicalCpus, core.host.logicalCpus, standard.host.logicalCpus, dense.host.logicalCpus], [4, 4, 8, 16])
  assert.deepEqual([lite.host.memoryBytes, core.host.memoryBytes, standard.host.memoryBytes, dense.host.memoryBytes], [8, 16, 32, 64].map((value) => value * 1024 ** 3))
  assert.deepEqual([lite.host.freeBytes, core.host.freeBytes, standard.host.freeBytes, dense.host.freeBytes], [60, 100, 200, 500].map((value) => value * 1024 ** 3))
  assert.deepEqual([lite.project.cpus, lite.project.memoryMb, lite.project.diskGb], [2, 4096, 32])
  assert.deepEqual([core.project.cpus, core.project.memoryMb, core.project.diskGb], [2, 4096, 40])
  assert.deepEqual([standard.project.cpus, standard.project.memoryMb, standard.project.diskGb], [4, 8192, 64])
  assert.deepEqual([dense.project.cpus, dense.project.memoryMb, dense.project.diskGb], [2, 6144, 64])
})

test('profile and runtime are normalized independently with compatibility defaults', () => {
  assert.equal(resolveDeploymentProfile().name, 'standard')
  assert.equal(resolveDeploymentProfile(' DENSE ').name, 'dense')
  assert.equal(resolveProjectRuntime(), 'vm')
  assert.equal(resolveProjectRuntime(' Container '), 'container')
  assert.equal(resolveProjectRuntime('AUTO', { allowAuto: true }), 'auto')
  assert.equal(isolationClass('vm'), 'vm')
  assert.equal(isolationClass('container'), 'container')
  assert.throws(() => resolveDeploymentProfile('large'), /lite, core, standard, dense/i)
  assert.throws(() => resolveProjectRuntime('auto'), /container, vm/i)
})

test('profile environment combines sizing and isolation without coupling them', () => {
  const standardContainer = profileEnvironment('standard', 'container')
  assert.equal(standardContainer.OPENLINK_DEPLOYMENT_PROFILE, 'standard')
  assert.equal(standardContainer.OPENLINK_PROJECT_RUNTIME, 'container')
  assert.equal(standardContainer.OPENLINK_PROJECT_ISOLATION, 'container')
  assert.equal(standardContainer.OPENLINK_KNOWLEDGE_ENABLED, '1')
  assert.equal(standardContainer.OPENLINK_ZERO_ENABLED, '1')
  const coreVm = profileEnvironment('core', 'vm')
  assert.equal(coreVm.OPENLINK_PROJECT_ISOLATION, 'vm')
  assert.equal(coreVm.OPENLINK_KNOWLEDGE_ENABLED, '0')
  assert.equal(coreVm.OPENLINK_ZERO_ENABLED, '0')
  const liteVm = profileEnvironment('lite', 'vm')
  assert.equal(liteVm.OPENLINK_PROJECT_RUNTIME_EAGER, '0')
  assert.equal(coreVm.OPENLINK_PROJECT_RUNTIME_EAGER, undefined)
})

