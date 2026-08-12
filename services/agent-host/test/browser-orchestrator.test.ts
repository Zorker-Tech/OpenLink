import test from 'node:test'
import assert from 'node:assert/strict'
import type { AgentLaunchSpec, ProvisionedEnvironment } from '../src/contracts.js'
import { BrowserEnabledAgentOrchestrator } from '../src/browser-orchestrator.js'
import type { BrowserHostClient } from '../src/browser-client.js'

function spec(): AgentLaunchSpec {
  return {
    userId: 'user-1', workspaceId: 'workspace-1', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', sessionId: 'agent-1',
    target: { kind: 'local', workspaceRoot: '/workspace', storageRoot: '/storage' },
    workspaceRoot: '/workspace', storageRoot: '/storage', piEntrypoint: '/opt/pi.js', sessionDir: '/storage/sessions',
    environment: {}, policy: { allowedDomains: ['example.com'], deniedDomains: [], allowWrite: ['/workspace'], denyWrite: [], denyRead: [], allowUnixSockets: [] },
  }
}

test('browser-enabled orchestration binds a scoped session into Pi and cleans up both runtimes', async () => {
  let provisioned: AgentLaunchSpec | undefined
  let launched: AgentLaunchSpec | undefined
  let agentCleaned = false
  let browserCleaned = false
  const environment: ProvisionedEnvironment = {
    runtime: 'local-sandbox-runtime', workspaceRoot: '/workspace', storageRoot: '/storage',
    launchPi: async (launchSpec) => {
      launched = launchSpec
      return { command: { executable: 'node', args: [], cwd: '/workspace', env: {}, shell: false }, events: (async function* () {})(), send: async () => {}, stop: async () => {} }
    },
    cleanup: async () => { agentCleaned = true },
  }
  const agents = { provision: async (launchSpec: AgentLaunchSpec) => { provisioned = launchSpec; return environment } }
  const browsers = {
    runtimeUrl: 'http://127.0.0.1:43120',
    createChromiumSession: async () => ({ state: { id: 'browser-1' }, controlToken: 'agent-token', connection: { eventsUrl: 'ws://127.0.0.1:43120/events' } }),
    close: async (id: string) => { assert.equal(id, 'browser-1'); browserCleaned = true },
  } as unknown as BrowserHostClient
  const orchestrator = new BrowserEnabledAgentOrchestrator(agents, browsers)
  const result = await orchestrator.provision(spec(), { extensionPath: '/opt/openlink/openlink-browser.ts' })
  assert.equal(provisioned?.browser?.sessionId, 'browser-1')
  await result.launchPi()
  assert.equal(launched?.browser?.controlToken, 'agent-token')
  await result.cleanup()
  assert.equal(agentCleaned, true)
  assert.equal(browserCleaned, true)
})
