/**
 * The permissions a shell command may ask for.
 *
 * A command that needs the network or the ability to write says so in its arguments, and what it is
 * allowed to ask for depends on the session: a read-only session may ask for the network and nothing
 * else, a strict one may ask for the network or for everything but only one at a time, and an ordinary
 * one may also ask for write access to git. The list is read leniently, because a model that asks for a
 * single permission writes it as a bare word as often as it writes a list.
 *
 * The sandbox's network information is read here too: a session with a network allowlist — its own
 * defaults or an explicit entry — is one where a command may be told it has the network.
 */

import { z } from "zod"

import { lenientArray } from "../../lenient-array.ts"

export interface SandboxNetworkInfo {
  readonly hasDefaults: boolean
  readonly explicitEntries: readonly string[]
}

export function hasNetworkAllowlist(info: SandboxNetworkInfo | undefined): boolean {
  if (!info) return false
  return info.hasDefaults || info.explicitEntries.length > 0
}

export function getRequiredPermissionsSchema(options: { readonly isReadonly: boolean; readonly strict?: boolean }): z.ZodTypeAny {
  if (options.isReadonly) {
    return lenientArray(z.array(z.enum(["full_network", "network"])), {
      field: "required_permissions",
      primitiveItems: true,
    }).optional().describe("Optional list of permissions to request if the command needs them (full_network).")
  }
  if (options.strict === true) {
    // One permission at a time, and nothing beyond the network or everything.
    return lenientArray(z.array(z.enum(["full_network", "all"])).max(1), {
      field: "required_permissions",
      primitiveItems: true,
    }).optional().describe("Optional list of permissions to request if the command needs them (full_network, all).")
  }
  return lenientArray(z.array(z.enum(["git_write", "full_network", "network", "all"])), {
    field: "required_permissions",
    primitiveItems: true,
  }).optional().describe("Optional list of permissions to request if the command needs them (full_network, all).")
}
