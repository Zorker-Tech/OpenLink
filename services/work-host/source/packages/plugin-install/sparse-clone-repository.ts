import { access } from "node:fs/promises"
import { join } from "node:path"

import { materializeSpecForGitPaths } from "./sparse-clone-path-policy.ts"
import { execGitNonInteractive, type ExecGitNonInteractiveOptions } from "./git-command.ts"
import type { MaterializeSpec } from "./sparse-clone-path-policy.ts"

type SparseCheckoutDependencies = {
  readonly access: (path: string) => Promise<unknown>
  readonly runGit: (
    args: readonly string[],
    options?: ExecGitNonInteractiveOptions,
  ) => Promise<{ stdout: string; stderr: string }>
}

/** The repository operations behind sparse checkout, parameterized so the command contract can be tested directly. */
export function createSparseCheckoutCommands({ access: accessPath, runGit }: SparseCheckoutDependencies) {
  async function setSparseCheckoutDirs(
    repoDir: string,
    dirs: readonly string[],
    execOpts?: ExecGitNonInteractiveOptions,
  ): Promise<void> {
    await runGit(["sparse-checkout", "set", "--cone", "--", ...dirs], { ...execOpts, cwd: repoDir })
  }

  async function isSparseCheckoutRepo(repoDir: string): Promise<boolean> {
    try {
      await accessPath(join(repoDir, ".git", "info", "sparse-checkout"))
    } catch {
      return false
    }

    try {
      const setting = await runGit(["config", "--bool", "--get", "core.sparseCheckout"], { cwd: repoDir })
      return setting.stdout.trim() === "true"
    } catch {
      return false
    }
  }

  async function materializeSparseDirs(
    repoDir: string,
    spec: MaterializeSpec,
    execOpts?: ExecGitNonInteractiveOptions,
  ): Promise<void> {
    if (spec !== "all" && spec.length === 0) return
    if (!await isSparseCheckoutRepo(repoDir)) return

    const options = { ...execOpts, cwd: repoDir, sshBatchMode: true }
    const widenCheckout = () => runGit(["sparse-checkout", "disable"], options)
    if (spec === "all") {
      await widenCheckout()
      return
    }

    const directories = materializeSpecForGitPaths(spec)
    if (directories === "all") {
      await widenCheckout()
      return
    }
    await runGit(["sparse-checkout", "add", "--", ...directories], options)
  }

  return { setSparseCheckoutDirs, isSparseCheckoutRepo, materializeSparseDirs }
}

const checkout = createSparseCheckoutCommands({ access, runGit: execGitNonInteractive })

export const setSparseCheckoutDirs = checkout.setSparseCheckoutDirs
export const isSparseCheckoutRepo = checkout.isSparseCheckoutRepo
export const materializeSparseDirs = checkout.materializeSparseDirs
