import type { AgentLaunchSpec, AgentProcess, ProvisionedEnvironment } from './contracts.js'
import { AgentHostError } from './errors.js'
import { BrowserHostClient, type BrowserAgentSession } from './browser-client.js'

export interface AgentEnvironmentProvisioner {
  provision(spec: AgentLaunchSpec): Promise<ProvisionedEnvironment>
}

export interface BrowserProvisionOptions {
  extensionPath: string
  initialUrl?: string
  viewport?: BrowserAgentSession['state']['viewport']
  allowedDomains?: string[]
  deniedDomains?: string[]
  allowLoopback?: boolean
  allowPrivateNetworks?: boolean
}

export interface BrowserEnabledEnvironment {
  readonly agent: ProvisionedEnvironment
  readonly browser: BrowserAgentSession
  launchPi(spec?: AgentLaunchSpec): Promise<AgentProcess>
  cleanup(): Promise<void>
}

export class BrowserEnabledAgentOrchestrator {
  constructor(
    private readonly agents: AgentEnvironmentProvisioner,
    private readonly browsers: BrowserHostClient,
  ) {}

  async provision(spec: AgentLaunchSpec, options: BrowserProvisionOptions): Promise<BrowserEnabledEnvironment> {
    if (!options.extensionPath || /[\u0000-\u001f]/.test(options.extensionPath)) {
      throw new AgentHostError('INVALID_PATH', 'Browser extension path is invalid')
    }
    const browser = await this.browsers.createChromiumSession({
      ownerId: spec.userId,
      workspaceId: spec.workspaceId,
      projectId: spec.projectId,
      initialUrl: options.initialUrl,
      viewport: options.viewport,
      allowedDomains: options.allowedDomains ?? spec.policy.allowedDomains,
      deniedDomains: options.deniedDomains ?? spec.policy.deniedDomains,
      allowLoopback: options.allowLoopback,
      allowPrivateNetworks: options.allowPrivateNetworks,
    })
    const boundSpec: AgentLaunchSpec = {
      ...spec,
      browser: {
        hostUrl: this.browsers.runtimeUrl,
        sessionId: browser.state.id,
        controlToken: browser.controlToken,
        extensionPath: options.extensionPath,
      },
    }

    let agent: ProvisionedEnvironment
    try {
      agent = await this.agents.provision(boundSpec)
    } catch (error) {
      try {
        await this.browsers.close(browser.state.id)
      } catch (cleanupError) {
        console.error(`OpenLink browser cleanup failed after Agent Host provisioning error: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
      }
      throw error
    }

    let cleaned = false
    let cleanupPromise: Promise<void> | undefined
    return {
      agent,
      browser,
      launchPi: (launchSpec = boundSpec) => agent.launchPi({ ...launchSpec, browser: boundSpec.browser }),
      cleanup: async () => {
        if (cleaned) return
        if (cleanupPromise) return cleanupPromise
        cleanupPromise = (async () => {
          const [agentResult, browserResult] = await Promise.allSettled([
            agent.cleanup(),
            this.browsers.close(browser.state.id),
          ])
          const failures = [agentResult, browserResult]
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map((result) => result.reason)
          if (failures.length) throw new AggregateError(failures, 'OpenLink browser-enabled environment cleanup failed')
          cleaned = true
        })().catch((error) => {
          cleanupPromise = undefined
          throw error
        })
        return cleanupPromise
      },
    }
  }
}
