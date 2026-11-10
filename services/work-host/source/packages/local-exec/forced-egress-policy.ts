import {
  dependencyCommandPattern,
  forcedEgressOverrides,
  sourceLookupPattern,
} from "./forced-egress-config.ts"

const COMMAND_SUBSTITUTION = /\$\(|\x60|<\(|>\(/
const SHELL_CONTROL = /[;&|]/

export interface ForcedEgressCommand {
  readonly fullText?: string | undefined
  readonly name?: string | undefined
}

export interface ForcedEgressParsingResult {
  readonly parsingFailed?: boolean | undefined
  readonly executableCommands?: readonly ForcedEgressCommand[] | undefined
}

export interface ForcedEgressSandboxPolicy {
  readonly type: "workspace_readwrite"
  readonly additionalReadwritePaths?: string[]
  readonly networkPolicy: {
    readonly version: 1
    readonly default: "allow" | "deny"
    readonly allow?: string[]
    readonly deny?: string[]
  }
  readonly networkPolicyStrict?: true
  readonly skipStatsigDefaults: true
  readonly enableSharedBuildCache: true
}

function loopbackOnlyPolicy(): ForcedEgressSandboxPolicy {
  const settings = forcedEgressOverrides()
  return {
    type: "workspace_readwrite",
    ...(settings.writablePaths.length === 0 ? {} : { additionalReadwritePaths: settings.writablePaths }),
    networkPolicy: {
      version: 1,
      default: settings.networkDefault,
      allow: ["127.0.0.0/8", "::1/128", "localhost", ...settings.allowDomains],
      ...(settings.denyDomains.length === 0 ? {} : { deny: settings.denyDomains }),
    },
    networkPolicyStrict: true,
    skipStatsigDefaults: true,
    enableSharedBuildCache: true,
  }
}

function dependencyOnlyPolicy(): ForcedEgressSandboxPolicy {
  const settings = forcedEgressOverrides()
  return {
    type: "workspace_readwrite",
    ...(settings.writablePaths.length === 0 ? {} : { additionalReadwritePaths: settings.writablePaths }),
    networkPolicy: {
      version: 1,
      default: "allow",
      ...(settings.dependencyDenyDomains.length === 0 ? {} : { deny: settings.dependencyDenyDomains }),
    },
    skipStatsigDefaults: true,
    enableSharedBuildCache: true,
  }
}

function commandText(command: ForcedEgressCommand): string {
  return command.fullText?.trim() || command.name?.trim() || ""
}

function removeLeadingEnvironmentAssignments(command: string): string {
  return command.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)*/, "")
}

function commandIsSafeToClassify(text: string, sourcePattern: RegExp | null): boolean {
  return text.length > 0 && sourcePattern?.test(text) !== true && SHELL_CONTROL.test(text) !== true
}

export function forcedShellSandboxPolicy(
  command: string,
  parsing: ForcedEgressParsingResult | undefined,
): ForcedEgressSandboxPolicy {
  const fallback = loopbackOnlyPolicy()
  const dependencyPattern = dependencyCommandPattern()
  if (dependencyPattern === null) return fallback

  const commands = parsing?.executableCommands ?? []
  if (parsing?.parsingFailed === true || commands.length === 0 || COMMAND_SUBSTITUTION.test(command)) return fallback

  const sourcePattern = sourceLookupPattern()
  const text = commands.map(commandText)
  if (text.some(item => !commandIsSafeToClassify(item, sourcePattern))) return fallback
  return text.every(item => dependencyPattern.test(removeLeadingEnvironmentAssignments(item)))
    ? dependencyOnlyPolicy()
    : fallback
}
