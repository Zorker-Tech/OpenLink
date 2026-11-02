import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_DESKTOP_SKILL,
  desktopAutomationAvailable,
  desktopAutomationEnvironment,
  desktopAutomationSkillDirectories,
  desktopAutomationSkillFiles,
  desktopAutomationVolumes,
} from '../src/desktop-automation.js'
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

test('enables agent-desktop only for project-desktop architectures', () => {
  assert.equal(desktopAutomationAvailable(runtime('t1')), true)
  assert.equal(desktopAutomationAvailable(runtime('t2')), true)
  assert.equal(desktopAutomationAvailable(runtime('e1')), false)
  assert.equal(desktopAutomationAvailable(undefined), false)
})

test('injects the constrained desktop tool bridge environment', () => {
  assert.deepEqual(desktopAutomationEnvironment(runtime('t2')), {
    OPENLINK_DESKTOP_AUTOMATION: 'agent-desktop',
    OPENLINK_DESKTOP_TOOL_SOCKET: '/run/user/1000/openlink-desktop-tool.sock',
  })
  assert.deepEqual(desktopAutomationEnvironment(runtime('t1')), desktopAutomationEnvironment(runtime('t2')))
})

test('mounts only the CLI shim and the host bridge socket read-only', () => {
  const volumes = desktopAutomationVolumes(runtime('t2'))
  assert.deepEqual(volumes.map((volume) => volume.mountPath), [
    '/usr/local/bin/agent-desktop',
    '/run/user/1000/openlink-desktop-tool.sock',
  ])
  assert.ok(volumes.every((volume) => volume.readOnly))
  assert.equal(desktopAutomationVolumes(runtime('t1')).length, 2)
})

test('writes the agent-desktop skill to Pi and Codex skill roots', () => {
  const directories = desktopAutomationSkillDirectories()
  assert.ok(directories.includes('/root/.pi/agent/skills/agent-desktop'))
  assert.ok(directories.includes('/root/.codex/skills/agent-desktop'))
  const files = desktopAutomationSkillFiles()
  assert.equal(files.length, directories.length)
  assert.ok(files.every((file) => file.data === AGENT_DESKTOP_SKILL))
  assert.match(AGENT_DESKTOP_SKILL, /agent-desktop snapshot/)
})
