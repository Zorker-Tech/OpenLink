import type { AgentLaunchSpec, ProvisionedEnvironment, SandboxBackend } from './contracts.js'
import { AgentHostError } from './errors.js'

export class AgentOrchestrator {
  constructor(
    private readonly backends: {
      local: SandboxBackend
      remote: SandboxBackend
    },
  ) {}

  provision(spec: AgentLaunchSpec): Promise<ProvisionedEnvironment> {
    if (spec.target.kind === 'local') return this.backends.local.provision(spec)
    if (spec.target.kind === 'ssh') return this.backends.remote.provision(spec)
    throw new AgentHostError('INVALID_TARGET', 'Unsupported execution target')
  }
}
