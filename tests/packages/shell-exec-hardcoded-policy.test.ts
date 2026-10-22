import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import {
  convertPathsToIgnoreMapping,
  getGitWriteProtectionMapping,
  getHardcodedAllowedReadPaths,
  getHardcodedSandboxPolicy,
  getWorktreeWriteProtectionMapping,
} from "../../source/packages/shell-exec/sandbox/hardcoded-policy.ts"

const withTempDir = (run: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "hardcoded-policy-test-"))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("the read allowlist is the platform's own, and only what the installation has for a bundled path", () => {
  const linux = getHardcodedAllowedReadPaths("linux", "/home/someone", {})
  assert.equal(linux.includes("/bin"), true)
  assert.equal(linux.includes("/usr/bin"), true)
  assert.equal(linux.some((entry) => entry.startsWith("/System")), false)
  const darwin = getHardcodedAllowedReadPaths("darwin", "/Users/someone", {})
  assert.equal(darwin.length > 0, true)
  assert.equal(darwin.includes("/System/Library"), true, "the darwin policy has its own system library")
  assert.equal(darwin.includes("/etc/pki/ca-trust/extracted"), false, "the linux-only entries do not leak into the other platform's policy")
  assert.deepEqual(getHardcodedAllowedReadPaths("win32", "/home/someone", {}), [])

  withTempDir((dir) => {
    const bundled = join(dir, "bin")
    writeFileSync(bundled, "x")
    const anyBundled = new Proxy({}, { get: () => bundled }) as never
    const withBundled = getHardcodedAllowedReadPaths("linux", dir, anyBundled)
    assert.equal(withBundled.includes(bundled), true, "a bundled path that exists is allowed")
    const noneBundled = new Proxy({}, { get: () => join(dir, "missing") }) as never
    const withMissing = getHardcodedAllowedReadPaths("linux", dir, noneBundled)
    assert.equal(withMissing.some((entry) => entry.endsWith("missing")), false, "a bundled path that does not exist is skipped")
    mkdirSync(join(dir, "bundled-directory"))
    const anyDirectory = new Proxy({}, { get: () => join(dir, "bundled-directory") }) as never
    assert.equal(getHardcodedAllowedReadPaths("linux", dir, anyDirectory).includes(join(dir, "bundled-directory")), false, "a bundled path that is a directory is skipped")
  })
})

test("a path becomes the patterns that ignore it, whether it is a directory, a file or missing", () => {
  withTempDir((dir) => {
    const file = join(dir, "file.txt")
    const nested = join(dir, "nested", "deeper")
    writeFileSync(file, "x")
    mkdirSync(nested, { recursive: true })
    assert.deepEqual(convertPathsToIgnoreMapping(nested), { [nested]: ["**"] })
    assert.deepEqual(convertPathsToIgnoreMapping(file), { [dir]: ["file.txt", "file.txt/**"] })
    assert.deepEqual(convertPathsToIgnoreMapping(join(dir, "missing")), { [dir]: ["missing", "missing/**"] }, "a missing path is treated as a file")
    assert.deepEqual(convertPathsToIgnoreMapping(nested, file), { [nested]: ["**"], [dir]: ["file.txt", "file.txt/**"] })
    assert.deepEqual(convertPathsToIgnoreMapping(), {})
    assert.deepEqual(convertPathsToIgnoreMapping("/"), { "/": ["**"] })
    assert.deepEqual(convertPathsToIgnoreMapping("/file"), { "/": ["file", "file/**"] }, "a file at the root keeps the root as its directory")
  })
})

test("the write protections are grouped by what they protect, and the policy assembles them", () => {
  const workspace = "/work/space"
  const workspaceMapping = getWorkspaceMapping(workspace)
  assert.deepEqual(Object.keys(workspaceMapping), [workspace])
  assert.equal(workspaceMapping[workspace]!.includes("**/.cursor/*.json"), true)
  assert.equal(workspaceMapping[workspace]!.includes("**/.vscode/**"), true)
  const gitMapping = getGitWriteProtectionMapping("/repo/.git/..")
  assert.deepEqual(Object.keys(gitMapping), ["/repo/.git/.."])
  assert.equal(gitMapping["/repo/.git/.."]!.includes("**/.git/hooks/**"), true)
  assert.equal(gitMapping["/repo/.git/.."]!.includes("**/.vscode/**"), false, "a workspace rule is not a git rule")
  assert.deepEqual(Object.keys(getWorktreeWriteProtectionMapping(workspace)), [workspace])
  assert.deepEqual(workspaceMapping[workspace], getHardcodedSandboxPolicy(workspace).writeProtectionMapping[workspace])
  const policy = getHardcodedSandboxPolicy(workspace)
  assert.equal(policy.type, "workspace_readwrite")
  assert.equal(policy.networkPolicyStrict, true)
  assert.equal(policy.networkPolicy, undefined, "the hardcoded policy carries no network rules")
  assert.equal(policy.additionalReadonlyPaths.includes(join(homedir(), ".slate/sandbox-policies")), true)
  for (const path of policy.additionalReadonlyPaths) assert.equal(path.includes("cursor"), false, path)
})

const getWorkspaceMapping = (workspace: string) => getHardcodedSandboxPolicy(workspace).writeProtectionMapping
