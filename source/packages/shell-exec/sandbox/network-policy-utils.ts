/**
 * The network policy a sandboxed command runs under, and the two answers it can give.
 *
 * A policy is a default plus a list of exceptions, and the default when none is given is to deny: a command
 * that was not explicitly allowed to reach the network should not be able to, since the sandbox exists to
 * make that promise. A policy that allows everything or names anything to allow is what "network is
 * enabled" means, which is the question the rest of the sandbox asks.
 */

export interface NetworkPolicy { version: 1; default: "allow" | "deny"; allow?: readonly string[]; deny?: readonly string[] }
export const getEffectiveNetworkPolicy = (policy: NetworkPolicy | undefined): NetworkPolicy => policy !== undefined ? policy : { version: 1, default: "deny" }
export const isNetworkEnabledByPolicy = (policy: NetworkPolicy | undefined): boolean => policy !== undefined && (policy.default === "allow" || (policy.allow !== undefined && policy.allow.length > 0))
export const networkDisabledPolicy = (): NetworkPolicy => ({ version: 1, default: "deny" })
export const networkAllowAllPolicy = (): NetworkPolicy => ({ version: 1, default: "allow" })
