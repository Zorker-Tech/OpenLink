import type { AgentLaunchSpec, AgentProcess, ProvisionedEnvironment, SandboxBackend } from '../contracts.js'
import { AgentHostError } from '../errors.js'
import { compileSandboxPolicy } from '../policy.js'
import { buildPiRpcCommand, type CommandSpec } from '../pi-rpc.js'
import type { ProjectRuntimeDescriptor } from '../project-runtime.js'

export interface SandboxRuntimeAdapter {
  initialize(config: unknown): Promise<void>
  wrapWithSandboxArgv(command: string, shell: string | undefined, config: unknown, signal: AbortSignal | undefined, cwd: string): Promise<{ argv: string[]; env: Record<string, string | undefined> }>
  reset(): Promise<void>
}

export type AgentProcessFactory = (command: CommandSpec) => Promise<AgentProcess>

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function commandText(command: CommandSpec): string {
  return [command.executable, ...command.args].map(shellQuote).join(' ')
}

const HOST_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
])

function filterSpawnEnvironment(
  wrapped: Record<string, string | undefined>,
  agent: Record<string, string>,
): Record<string, string> {
  const safe = Object.entries(wrapped).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && (HOST_ENV_ALLOWLIST.has(entry[0]) || entry[0].startsWith('SRT_')),
  )
  const maskedAgent = Object.fromEntries(
    Object.keys(agent)
      .filter((key) => wrapped[key] !== undefined)
      .map((key) => [key, wrapped[key] as string]),
  )
  return { ...Object.fromEntries(safe), ...agent, ...maskedAgent }
}

export class LocalSandboxRuntimeBackend implements SandboxBackend {
  readonly runtime = 'local-sandbox-runtime' as const

  constructor(
    private readonly sandboxRuntime: SandboxRuntimeAdapter,
    private readonly spawnProcess?: AgentProcessFactory,
  ) {}

  async provision(spec: AgentLaunchSpec, _projectRuntime?: ProjectRuntimeDescriptor): Promise<ProvisionedEnvironment> {
    const compiled = compileSandboxPolicy(spec.workspaceRoot, spec.storageRoot, spec.policy)
    await this.sandboxRuntime.initialize(compiled)
    return {
      runtime: this.runtime,
      workspaceRoot: spec.workspaceRoot,
      storageRoot: spec.storageRoot,
      launchPi: async (launchSpec) => {
        if (!this.spawnProcess) {
          throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Local process factory is not configured')
        }
        const command = buildPiRpcCommand({
          entrypoint: launchSpec.piEntrypoint,
          cwd: launchSpec.workspaceRoot,
          sessionDir: launchSpec.sessionDir,
          sessionId: launchSpec.sessionId,
          model: launchSpec.model,
          environment: launchSpec.environment,
          browser: launchSpec.browser,
        })
        const wrapped = await this.sandboxRuntime.wrapWithSandboxArgv(
          commandText(command),
          undefined,
          compileSandboxPolicy(launchSpec.workspaceRoot, launchSpec.storageRoot, launchSpec.policy),
          undefined,
          launchSpec.workspaceRoot,
        )
        return this.spawnProcess({
          ...command,
          executable: wrapped.argv[0] ?? command.executable,
          args: wrapped.argv.slice(1),
          env: filterSpawnEnvironment(wrapped.env, command.env),
        })
      },
      cleanup: () => this.sandboxRuntime.reset(),
    }
  }
}
