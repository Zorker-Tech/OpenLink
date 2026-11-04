/** The permissions a shell command can request under each session policy. */
import { z } from "zod"
import { lenientArray } from "../../lenient-array.ts"

export interface SandboxNetworkInfo {
  readonly hasDefaults: boolean
  readonly explicitEntries: readonly string[]
}

export function hasNetworkAllowlist(info: SandboxNetworkInfo | undefined): boolean {
  return info != null && (info.hasDefaults || info.explicitEntries.length > 0)
}

type PermissionChoices = readonly [string, ...string[]]

interface PermissionProfile {
  readonly choices: PermissionChoices
  readonly maximumCount?: number | undefined
  readonly description: string
}

const READ_ONLY_PROFILE: PermissionProfile = {
  choices: ["full_network", "network"],
  description: "Optional list of permissions to request if the command needs them (full_network).",
}

const STRICT_PROFILE: PermissionProfile = {
  choices: ["full_network", "all"],
  maximumCount: 1,
  description: "Optional list of permissions to request if the command needs them (full_network, all).",
}

const FLEXIBLE_PROFILE: PermissionProfile = {
  choices: ["git_write", "full_network", "network", "all"],
  description: "Optional list of permissions to request if the command needs them (full_network, all).",
}

function permissionListSchema(profile: PermissionProfile): z.ZodTypeAny {
  const allowed = z.array(z.enum([...profile.choices] as [string, ...string[]]))
  const bounded = profile.maximumCount === undefined ? allowed : allowed.max(profile.maximumCount)
  return lenientArray(bounded, {
    field: "required_permissions",
    primitiveItems: true,
  }).optional().describe(profile.description)
}

export function getRequiredPermissionsSchema(options: {
  readonly isReadonly: boolean
  readonly strict?: boolean | undefined
}): z.ZodTypeAny {
  const profile = options.isReadonly
    ? READ_ONLY_PROFILE
    : options.strict === true
      ? STRICT_PROFILE
      : FLEXIBLE_PROFILE
  return permissionListSchema(profile)
}
