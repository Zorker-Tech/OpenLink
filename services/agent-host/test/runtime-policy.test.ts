import assert from 'node:assert/strict'
import test from 'node:test'

import { RUNTIME_POLICY_REVISION, runtimePolicyEnvironment, runtimePolicyFor } from '../src/runtime-policy.js'
import type { ProjectRuntimeDescriptor } from '../src/project-runtime.js'

function runtime(architecture: 't1' | 't2' | 'e1'): ProjectRuntimeDescriptor {
  return {
    projectId: '00000000-0000-4000-8000-000000000001',
    machineName: 'test',
    workspacePath: '/workspace',
    architecture,
    backend: architecture === 'e1' ? 'podman-machine' : 'qemu-kvm',
    diskMode: 'thin',
    status: 'ready',
    servicePorts: {
      opensandbox: 51000,
      browserHost: 52000,
      codeServer: 53000,
      supabaseGateway: 54000,
      supabaseDatabase: 55000,
      supabasePooler: 56000,
      desktop: 57000,
    },
    opensandboxEndpoint: 'http://127.0.0.1:51000',
    browserHostEndpoint: 'http://127.0.0.1:52000',
    codeServerEndpoint: 'http://127.0.0.1:53000',
    desktopEndpoint: architecture === 'e1' ? undefined : 'http://127.0.0.1:57000',
    sessionStorageRoot: '/workspace/.openlink/sessions',
  } as ProjectRuntimeDescriptor
}

test('runtime policy advertises desktop only where the bridge exists', () => {
  for (const architecture of ['t1', 't2'] as const) {
    const policy = runtimePolicyFor(runtime(architecture))
    assert.ok(policy)
    assert.match(policy, /desktop_snapshot/)
    assert.match(policy, /agent-tools\/manifest\.tsv/)
    assert.match(policy, new RegExp(architecture.toUpperCase()))
  }
  const e1 = runtimePolicyFor(runtime('e1'))
  assert.ok(e1)
  assert.doesNotMatch(e1, /desktop_snapshot/)
  assert.match(e1, /agent-tools\/manifest\.tsv/)
})

test('runtime policy environment is versioned and absent without a runtime', () => {
  const env = runtimePolicyEnvironment(runtime('t2'))
  assert.equal(env.OPENLINK_AGENT_RUNTIME_POLICY_REVISION, RUNTIME_POLICY_REVISION)
  assert.match(env.OPENLINK_AGENT_RUNTIME_POLICY, /Only advertise or use capabilities/)
  assert.deepEqual(runtimePolicyEnvironment(undefined), {})
})
