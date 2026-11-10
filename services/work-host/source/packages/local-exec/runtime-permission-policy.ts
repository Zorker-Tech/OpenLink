import type { SandboxRule } from "./shell-core.ts"

type ShellDecision = (
  context: unknown,
  command: string,
  options: unknown,
  requestedPolicy?: SandboxRule,
) => Promise<{ kind: "allow"; policy: SandboxRule }>

type InvariantDecision = (
  context: unknown,
  options: unknown,
  requestedPolicy?: SandboxRule,
) => Promise<{ kind: "allow" }>

type ShellAllowlistProbe = (context: unknown, command: string, options: unknown) => Promise<boolean>
type McpAllowlistProbe = (context: unknown, options: unknown) => Promise<boolean>

/** Permission decisions supplied by the local executor's default daemon assembly. */
export class PermissiveLocalExecAuthorization {
  private decideShell: ShellDecision = async (_context, _command, _options, requestedPolicy) => ({
    kind: "allow",
    policy: requestedPolicy ?? { type: "insecure_none" },
  })

  private decideInvariant: InvariantDecision = async () => ({ kind: "allow" })
  private probeShellAllowlist: ShellAllowlistProbe = async () => false
  private probeMcpAllowlist: McpAllowlistProbe = async () => false

  async shouldBlockRead(_path: string): Promise<boolean> { return false }
  async shouldBlockWrite(_context: unknown, _path: string, _contents: string): Promise<boolean> { return false }

  shouldBlockShellCommand(context: unknown, command: string, options: unknown, policy?: SandboxRule) {
    return this.decideShell(context, command, options, policy)
  }

  shouldEnforceShellInvariantBlocks(context: unknown, options: unknown, policy?: SandboxRule) {
    return this.decideInvariant(context, options, policy)
  }

  isShellCommandFullyAllowlisted(context: unknown, command: string, options: unknown) {
    return this.probeShellAllowlist(context, command, options)
  }

  isMcpFullyAllowlisted(context: unknown, options: unknown) {
    return this.probeMcpAllowlist(context, options)
  }

  async shouldBlockMcp(_context: unknown, _args: unknown): Promise<boolean> { return false }
  async isWebFetchFullyAllowlisted(_context: unknown, _options: unknown): Promise<boolean> { return false }
  async addToAllowList(_context: unknown, _kind: unknown, _value: unknown): Promise<void> {}
  async addToDenyList(_context: unknown, _kind: unknown, _value: unknown): Promise<void> {}

  setShellDecision(decision: ShellDecision): void { this.decideShell = decision }
  setShellInvariantDecision(decision: InvariantDecision): void { this.decideInvariant = decision }
  setShellAllowlistProbe(probe: ShellAllowlistProbe): void { this.probeShellAllowlist = probe }
  setMcpAllowlistProbe(probe: McpAllowlistProbe): void { this.probeMcpAllowlist = probe }
}
