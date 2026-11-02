import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_TOOL_CLI,
  AGENT_TOOL_REGISTRY_ROOT,
  AGENT_TOOL_SANDBOX_ROOT,
  AGENT_TOOLS_SKILL,
  agentToolRegistryEnvironment,
  agentToolRegistryVolume,
  agentToolsAvailable,
  agentToolsSkillDirectories,
  agentToolsSkillFiles,
} from '../src/agent-tools.js'
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
    sessionStorageRoot: '/workspace/.openlink/sessions',
  } as ProjectRuntimeDescriptor
}

test('offers the project tool registry in every Project VM mode', () => {
  assert.equal(agentToolsAvailable(runtime('t1')), true)
  assert.equal(agentToolsAvailable(runtime('t2')), true)
  assert.equal(agentToolsAvailable(runtime('e1')), true)
  assert.equal(agentToolsAvailable(undefined), false)
})

test('mounts the registry read-only and prepends it to PATH', () => {
  assert.equal(agentToolRegistryVolume().host.path, AGENT_TOOL_REGISTRY_ROOT)
  assert.equal(agentToolRegistryVolume().mountPath, AGENT_TOOL_SANDBOX_ROOT)
  assert.equal(agentToolRegistryVolume().readOnly, true)
  assert.equal(agentToolRegistryEnvironment().PATH, `${AGENT_TOOL_SANDBOX_ROOT}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`)
  assert.equal(agentToolRegistryEnvironment().OPENLINK_AGENT_TOOL_REGISTRY, AGENT_TOOL_SANDBOX_ROOT)
})

test('teaches agents to discover the registry through manifest.tsv', () => {
  assert.match(AGENT_TOOLS_SKILL, /agent-tools/)
  assert.match(AGENT_TOOLS_SKILL, /manifest\.tsv/)
  assert.match(AGENT_TOOLS_SKILL, /openlink-agent-tool add/)
  const directories = agentToolsSkillDirectories()
  assert.ok(directories.includes('/root/.pi/agent/skills/agent-tools'))
  assert.ok(directories.includes('/root/.codex/skills/agent-tools'))
  assert.equal(agentToolsSkillFiles().length, directories.length)
  assert.ok(agentToolsSkillFiles().every((file) => file.data === AGENT_TOOLS_SKILL))
})

test('ships a registry controller with add/remove/list operations', () => {
  assert.match(AGENT_TOOL_CLI, /cmd_add/)
  assert.match(AGENT_TOOL_CLI, /cmd_remove/)
  assert.match(AGENT_TOOL_CLI, /manifest\.tsv/)
  assert.match(AGENT_TOOL_CLI, /OPENLINK_AGENT_TOOL_REGISTRY/)
})
