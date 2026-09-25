/**
 * Making sure a command cannot write the policy it is being run under.
 *
 * A sandbox is configured by a file on disk, and that file is the one thing a command must not be able to
 * change: a command that could rewrite its own policy would be able to grant itself what the policy denied.
 * So the directory the policy files live in is added to the read-only list of every policy — once, whatever
 * the policy already said, since a list that names the same path twice reads as two different rules.
 */

import { ensureSandboxPolicyDirectory } from "./policy-file.ts"

export function withPolicyDirectoryReadonly(additionalReadonlyPaths?: readonly string[]): readonly string[] {
  const directory = ensureSandboxPolicyDirectory()
  if (additionalReadonlyPaths === undefined || additionalReadonlyPaths.length === 0) {
    return [directory]
  }
  if (additionalReadonlyPaths.includes(directory)) {
    return additionalReadonlyPaths
  }
  return [...additionalReadonlyPaths, directory]
}

export function withSandboxPolicyDirectoryReadonly<Policy extends { readonly additionalReadonlyPaths?: readonly string[] }>(policy: Policy): Policy & { readonly additionalReadonlyPaths: readonly string[] } {
  return {
    ...policy,
    additionalReadonlyPaths: withPolicyDirectoryReadonly(policy.additionalReadonlyPaths),
  }
}
