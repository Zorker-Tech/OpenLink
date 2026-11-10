export const FORCED_SHELL_EGRESS_ENV = "SLATE_FORCED_SHELL_EGRESS"
export const FORCED_SHELL_EGRESS_DEPENDENCY_REGEX_ENV = "SLATE_FORCED_SHELL_EGRESS_DEPENDENCY_REGEX"
export const FORCED_SHELL_EGRESS_EXTRA_DEPENDENCY_REGEX_ENV = "SLATE_FORCED_SHELL_EGRESS_EXTRA_DEPENDENCY_REGEX"
export const FORCED_SHELL_EGRESS_SOURCE_REGEX_ENV = "SLATE_FORCED_SHELL_EGRESS_SOURCE_REGEX"
export const FORCED_SHELL_EGRESS_EXTRA_SOURCE_REGEX_ENV = "SLATE_FORCED_SHELL_EGRESS_EXTRA_SOURCE_REGEX"
export const FORCED_SHELL_EGRESS_NETWORK_DEFAULT_ENV = "SLATE_FORCED_SHELL_EGRESS_NETWORK_DEFAULT"
export const FORCED_SHELL_EGRESS_DENY_DOMAINS_ENV = "SLATE_FORCED_SHELL_EGRESS_DENY_DOMAINS"
export const FORCED_SHELL_EGRESS_DEPENDENCY_DENY_DOMAINS_ENV = "SLATE_FORCED_SHELL_EGRESS_DEPENDENCY_DENY_DOMAINS"
export const FORCED_SHELL_EGRESS_ALLOW_DOMAINS_ENV = "SLATE_FORCED_SHELL_EGRESS_ALLOW_DOMAINS"
export const FORCED_SHELL_EGRESS_WRITABLE_PATHS_ENV = "SLATE_FORCED_SHELL_EGRESS_WRITABLE_PATHS"

export interface ForcedEgressOverrides {
  readonly networkDefault: "allow" | "deny"
  readonly denyDomains: string[]
  readonly dependencyDenyDomains: string[]
  readonly allowDomains: string[]
  readonly writablePaths: string[]
}

let cachedEnabled: boolean | undefined
let cachedDependencyPattern: RegExp | null | undefined
let cachedSourcePattern: RegExp | null | undefined
let cachedOverrides: ForcedEgressOverrides | undefined

export function isForcedShellEgressEnabled(): boolean {
  if (cachedEnabled === undefined) {
    const setting = (process.env[FORCED_SHELL_EGRESS_ENV] ?? "").trim().toLowerCase()
    cachedEnabled = setting.length > 0 && !["0", "false", "off"].includes(setting)
  }
  return cachedEnabled
}

function readRegexSetting(name: string): string | undefined {
  const source = (process.env[name] ?? "").trim()
  if (source.length === 0) return undefined
  try {
    new RegExp(source, "i")
    return source
  } catch (error) {
    throw new Error("[forced-egress] invalid regex in " + name + ": " + String(error))
  }
}

function domainEntries(name: string): string[] {
  return (process.env[name] ?? "").split(",").map(entry => entry.trim()).filter(entry => entry.length > 0)
}

function absolutePaths(name: string): string[] {
  const entries = (process.env[name] ?? "").split(":").map(entry => entry.trim()).filter(entry => entry.length > 0)
  const paths = entries.filter(entry => entry.startsWith("/"))
  const dropped = entries.length - paths.length
  if (dropped > 0) {
    console.error("[forced-egress] ignoring " + dropped + " non-absolute path(s) in " + name + ".")
  }
  return paths
}

export function forcedEgressOverrides(): ForcedEgressOverrides {
  if (cachedOverrides !== undefined) return cachedOverrides

  const rawDefault = (process.env[FORCED_SHELL_EGRESS_NETWORK_DEFAULT_ENV] ?? "").trim().toLowerCase()
  let networkDefault: "allow" | "deny" = "deny"
  if (rawDefault === "allow" || rawDefault === "deny") networkDefault = rawDefault
  else if (rawDefault.length > 0) {
    console.error("[forced-egress] ignoring invalid value in " + FORCED_SHELL_EGRESS_NETWORK_DEFAULT_ENV + " (expected \"allow\" or \"deny\"); using \"deny\".")
  }

  const denyDomains = domainEntries(FORCED_SHELL_EGRESS_DENY_DOMAINS_ENV)
  const rawDependencyDeny = (process.env[FORCED_SHELL_EGRESS_DEPENDENCY_DENY_DOMAINS_ENV] ?? "").trim()
  const dependencyDenyDomains = rawDependencyDeny.toLowerCase() === "none"
    ? []
    : rawDependencyDeny.length > 0
      ? domainEntries(FORCED_SHELL_EGRESS_DEPENDENCY_DENY_DOMAINS_ENV)
      : denyDomains

  cachedOverrides = {
    networkDefault,
    denyDomains,
    dependencyDenyDomains,
    allowDomains: domainEntries(FORCED_SHELL_EGRESS_ALLOW_DOMAINS_ENV),
    writablePaths: absolutePaths(FORCED_SHELL_EGRESS_WRITABLE_PATHS_ENV),
  }
  return cachedOverrides
}

function configuredPattern(overrideName: string, additionalName: string, anchored: boolean): RegExp | null {
  const segments = [readRegexSetting(overrideName), readRegexSetting(additionalName)]
    .filter((segment): segment is string => segment !== undefined)
    .map(segment => "(?:" + segment + ")")
  if (segments.length === 0) return null

  const expression = segments.join("|")
  const beginning = anchored ? "^\\s*" : ""
  return new RegExp(beginning + "(?:" + expression + ")", "i")
}

export function dependencyCommandPattern(): RegExp | null {
  if (cachedDependencyPattern === undefined) {
    cachedDependencyPattern = configuredPattern(
      FORCED_SHELL_EGRESS_DEPENDENCY_REGEX_ENV,
      FORCED_SHELL_EGRESS_EXTRA_DEPENDENCY_REGEX_ENV,
      true,
    )
  }
  return cachedDependencyPattern
}

export function sourceLookupPattern(): RegExp | null {
  if (cachedSourcePattern === undefined) {
    cachedSourcePattern = configuredPattern(
      FORCED_SHELL_EGRESS_SOURCE_REGEX_ENV,
      FORCED_SHELL_EGRESS_EXTRA_SOURCE_REGEX_ENV,
      false,
    )
  }
  return cachedSourcePattern
}
