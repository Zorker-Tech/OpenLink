import { ensureSandboxPolicyDirectory } from "./policy-file.ts"

function protectPolicyDirectory(
  configuredPaths: readonly string[] | undefined,
  policyDirectory: string,
): readonly string[] {
  const existingPaths = configuredPaths ?? []
  return existingPaths.includes(policyDirectory)
    ? existingPaths
    : [...existingPaths, policyDirectory]
}

export function withPolicyDirectoryReadonly(additionalReadonlyPaths?: readonly string[]): readonly string[] {
  return protectPolicyDirectory(additionalReadonlyPaths, ensureSandboxPolicyDirectory())
}

export function withSandboxPolicyDirectoryReadonly<Policy extends { readonly additionalReadonlyPaths?: readonly string[] }>(
  policy: Policy,
): Policy & { readonly additionalReadonlyPaths: readonly string[] } {
  const additionalReadonlyPaths = withPolicyDirectoryReadonly(policy.additionalReadonlyPaths)
  return { ...policy, additionalReadonlyPaths }
}
