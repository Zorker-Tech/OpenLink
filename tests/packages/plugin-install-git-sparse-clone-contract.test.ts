import assert from "node:assert/strict"
import { test } from "node:test"

import { createSparseCheckoutCommands } from "../../source/packages/plugin-install/sparse-clone-repository.ts"
import { createSparseCloneSupportProbe } from "../../source/packages/plugin-install/sparse-clone-support.ts"
import { materializeSpecForGitPaths, resolveSparseClonePlan, serverIgnoredFilter } from "../../source/packages/plugin-install/git-sparse-clone.ts"
import type { ExecGitNonInteractiveOptions } from "../../source/adapters/interop/plugin-marketplace/git-subprocess-adapter.ts"

type GitCall = { args: readonly string[]; options?: ExecGitNonInteractiveOptions }

function recordCall(calls: GitCall[], args: readonly string[], options: ExecGitNonInteractiveOptions | undefined): void {
  calls.push(options === undefined ? { args } : { args, options })
}

test("materialization paths are normalized as repository-relative directories", () => {
  assert.deepEqual(materializeSpecForGitPaths([" ./skills/ ", "rules\\nested\\ "]), ["skills", "rules/nested"])
  assert.deepEqual(materializeSpecForGitPaths([]), [])
  assert.equal(materializeSpecForGitPaths(["skills", "../private"]), "all")
  assert.equal(materializeSpecForGitPaths(["/etc"]), "all")
  assert.equal(materializeSpecForGitPaths(["C:\\private"]), "all")
  assert.equal(materializeSpecForGitPaths(["skills//nested"]), "all")
})

test("a sparse plan adds required manifest roots once and avoids probing when it cannot be sparse", async () => {
  let probes = 0
  const supported = async () => { probes += 1; return true }

  assert.deepEqual(await resolveSparseClonePlan(["skills", "./hooks/", "skills"], true, supported), {
    materialize: ["skills", "hooks", "skills"],
    sparse: true,
    sparseDirs: [".cursor-plugin", ".claude-plugin", "skills", "hooks"],
  })
  assert.equal(probes, 1)
  assert.deepEqual(await resolveSparseClonePlan("all", true, supported), { materialize: "all", sparse: false, sparseDirs: [] })
  assert.deepEqual(await resolveSparseClonePlan(["../outside"], true, supported), { materialize: "all", sparse: false, sparseDirs: [] })
  assert.deepEqual(await resolveSparseClonePlan(["skills"], false, supported), { materialize: ["skills"], sparse: false, sparseDirs: [] })
  assert.equal(probes, 1)
})

test("sparse support checks respect the minimum version, cache one probe, and honor disablement", async () => {
  let reads = 0
  let disabled = true
  const probe = createSparseCloneSupportProbe({
    isDisabled: () => disabled,
    readVersion: async () => { reads += 1; return "git version 2.26.4.windows.1" },
  })

  assert.equal(await probe(), false)
  assert.equal(reads, 0)
  disabled = false
  assert.deepEqual(await Promise.all([probe(), probe()]), [true, true])
  assert.equal(reads, 1)
  disabled = true
  assert.equal(await probe(), false)
  assert.equal(reads, 1)

  const tooOld = createSparseCloneSupportProbe({ isDisabled: () => false, readVersion: async () => "git version 2.25.9" })
  const malformed = createSparseCloneSupportProbe({ isDisabled: () => false, readVersion: async () => "git version unknown" })
  const unavailable = createSparseCloneSupportProbe({ isDisabled: () => false, readVersion: async () => { throw new Error("git unavailable") } })
  assert.equal(await tooOld(), false)
  assert.equal(await malformed(), false)
  assert.equal(await unavailable(), false)
})

test("the server warning is matched without case sensitivity", () => {
  assert.equal(serverIgnoredFilter("warning: filtering not recognized by server"), true)
  assert.equal(serverIgnoredFilter("REMOTE: Filtering not recognized by server, ignoring"), true)
  assert.equal(serverIgnoredFilter("fatal: repository not found"), false)
})

test("sparse checkout commands use the repository as cwd and preserve caller options", async () => {
  const calls: GitCall[] = []
  const commands = createSparseCheckoutCommands({
    access: async () => {},
    runGit: async (args, options) => { recordCall(calls, args, options); return { stdout: "true\n", stderr: "" } },
  })

  await commands.setSparseCheckoutDirs("/repo", ["skills", "rules"], { cwd: "/ignored", timeoutMs: 1_500 })
  assert.deepEqual(calls, [{
    args: ["sparse-checkout", "set", "--cone", "--", "skills", "rules"],
    options: { cwd: "/repo", timeoutMs: 1_500 },
  }])
  calls.length = 0
  assert.equal(await commands.isSparseCheckoutRepo("/repo"), true)
  assert.deepEqual(calls, [{ args: ["config", "--bool", "--get", "core.sparseCheckout"], options: { cwd: "/repo" } }])
})

test("sparse checkout detection fails closed when metadata or the repository setting is absent", async () => {
  const calls: GitCall[] = []
  const missing = createSparseCheckoutCommands({
    access: async () => { throw new Error("missing") },
    runGit: async (args, options) => { recordCall(calls, args, options); return { stdout: "true", stderr: "" } },
  })
  assert.equal(await missing.isSparseCheckoutRepo("/repo"), false)
  assert.deepEqual(calls, [])

  const disabled = createSparseCheckoutCommands({
    access: async () => {},
    runGit: async () => ({ stdout: "false\n", stderr: "" }),
  })
  assert.equal(await disabled.isSparseCheckoutRepo("/repo"), false)

  const broken = createSparseCheckoutCommands({ access: async () => {}, runGit: async () => { throw new Error("git failed") } })
  assert.equal(await broken.isSparseCheckoutRepo("/repo"), false)
})

test("materialization is a no-op for empty or ordinary checkouts and widens sparse checkouts only as requested", async () => {
  const calls: GitCall[] = []
  let sparseMetadataExists = false
  const commands = createSparseCheckoutCommands({
    access: async () => { if (!sparseMetadataExists) throw new Error("not sparse") },
    runGit: async (args, options) => { recordCall(calls, args, options); return { stdout: "true", stderr: "" } },
  })

  await commands.materializeSparseDirs("/repo", [])
  await commands.materializeSparseDirs("/repo", ["skills"])
  assert.deepEqual(calls, [])

  sparseMetadataExists = true
  await commands.materializeSparseDirs("/repo", ["skills", "./rules/"], { timeoutMs: 9_000 })
  await commands.materializeSparseDirs("/repo", "all")
  await commands.materializeSparseDirs("/repo", ["../outside"])
  assert.deepEqual(calls, [
    { args: ["config", "--bool", "--get", "core.sparseCheckout"], options: { cwd: "/repo" } },
    { args: ["sparse-checkout", "add", "--", "skills", "rules"], options: { cwd: "/repo", timeoutMs: 9_000, sshBatchMode: true } },
    { args: ["config", "--bool", "--get", "core.sparseCheckout"], options: { cwd: "/repo" } },
    { args: ["sparse-checkout", "disable"], options: { cwd: "/repo", sshBatchMode: true } },
    { args: ["config", "--bool", "--get", "core.sparseCheckout"], options: { cwd: "/repo" } },
    { args: ["sparse-checkout", "disable"], options: { cwd: "/repo", sshBatchMode: true } },
  ])
})
