import type { HelperNetworkPolicy, HelperPolicyEnvelope, HelperSandboxPolicy } from "./helper-protocol-contracts.ts"

function policyAllowsAnyNetwork(policy: HelperNetworkPolicy): boolean {
  return policy.default === "allow" || (policy.allow?.length ?? 0) > 0
}

/** Keep only an effective network rule the helper needs to enforce. */
export function resolveNetworkPolicyForFile(sandboxPolicy: HelperSandboxPolicy): HelperNetworkPolicy | undefined {
  const rule = sandboxPolicy.networkPolicy
  if (sandboxPolicy.type === "insecure_none" || rule === undefined) return undefined
  if (!policyAllowsAnyNetwork(rule)) return undefined

  const hasDeniedHosts = (rule.deny?.length ?? 0) > 0
  if (rule.default === "allow" && !hasDeniedHosts) return undefined
  return { ...rule, version: 1 }
}

/** Build the policy file fields the helper understands, leaving all other sandbox details intact. */
export function buildSandboxPolicyEnvelope(
  sandbox: unknown,
  sandboxPolicy: HelperSandboxPolicy,
): HelperPolicyEnvelope {
  const networkPolicy = resolveNetworkPolicyForFile(sandboxPolicy)
  return {
    sandbox,
    ...(networkPolicy === undefined ? {} : { networkPolicy }),
    ...(sandboxPolicy.networkPolicyStrict === false ? { networkPolicyStrict: false as const } : {}),
  }
}
