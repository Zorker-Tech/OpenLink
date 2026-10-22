/**
 * The network policy a sandboxed command runs under, and the two answers it can give.
 *
 * A policy is a default plus a list of exceptions, and the default when none is given is to deny: a command
 * that was not explicitly allowed to reach the network should not be able to, since the sandbox exists to
 * make that promise. A policy that allows everything or names anything to allow is what "network is
 * enabled" means, which is the question the rest of the sandbox asks.
 */

export interface NetworkPolicy { version: 1; default: "allow" | "deny"; allow?: readonly string[]; deny?: readonly string[] }

/** The policy of a sandbox that may not reach the network at all. */
const denyAllPolicy = (): NetworkPolicy => ({ version: 1, default: "deny" })

/** The policy of a sandbox that may reach anything. */
const allowAllPolicy = (): NetworkPolicy => ({ version: 1, default: "allow" })

/** The policy a command actually runs under: the one it declared, or the deny-all default. */
export const getEffectiveNetworkPolicy = (declared: NetworkPolicy | undefined): NetworkPolicy =>
  declared !== undefined ? declared : denyAllPolicy()

/** Whether a policy names anything it may reach: allowed by default, or with a non-empty allow list. */
const hasAllowedNetwork = (policy: NetworkPolicy): boolean =>
  policy.default === "allow" || (policy.allow !== undefined && policy.allow.length > 0)

export const isNetworkEnabledByPolicy = (declared: NetworkPolicy | undefined): boolean =>
  declared !== undefined && hasAllowedNetwork(declared)

export const networkDisabledPolicy = (): NetworkPolicy => denyAllPolicy()

export const networkAllowAllPolicy = (): NetworkPolicy => allowAllPolicy()
