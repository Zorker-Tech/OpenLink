import { execGitNonInteractive } from "./git-command.ts"
import { MARKETPLACE_MANIFEST_PATHS } from "./manifest-parser.ts"
import {
  initialSparseDirectories,
  materializeSpecForGitPaths as normalizeGitPaths,
  serverIgnoredFilter,
} from "./sparse-clone-path-policy.ts"
import { createSparseCloneSupportProbe } from "./sparse-clone-support.ts"
import { isSparseCheckoutRepo, materializeSparseDirs, setSparseCheckoutDirs } from "./sparse-clone-repository.ts"
import type { MaterializeSpec } from "./sparse-clone-path-policy.ts"

export type { MaterializeSpec } from "./sparse-clone-path-policy.ts"
export { isSparseCheckoutRepo, materializeSparseDirs, serverIgnoredFilter, setSparseCheckoutDirs }

const DISABLE_SPARSE_PLUGIN_CLONES_ENV = "SLATE_DISABLE_SPARSE_PLUGIN_CLONES"

const supportsSparseCheckout = createSparseCloneSupportProbe({
  isDisabled: () => Boolean(process.env[DISABLE_SPARSE_PLUGIN_CLONES_ENV]),
  readVersion: async () => (await execGitNonInteractive(["--version"])).stdout,
})

export function materializeSpecForGitPaths(gitPaths: readonly string[]): MaterializeSpec {
  return normalizeGitPaths(gitPaths)
}

export async function resolveSparseClonePlan(
  requested: MaterializeSpec,
  sparsePluginClones: boolean,
  supportProbe: () => Promise<boolean> = supportsSparseCheckout,
): Promise<{ materialize: MaterializeSpec; sparse: boolean; sparseDirs: string[] }> {
  const materialize = requested === "all" ? "all" : normalizeGitPaths(requested)
  const sparse = sparsePluginClones && materialize !== "all" && await supportProbe()
  return {
    materialize,
    sparse,
    sparseDirs: sparse ? initialSparseDirectories(materialize, MARKETPLACE_MANIFEST_PATHS) : [],
  }
}
