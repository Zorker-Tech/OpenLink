import assert from "node:assert/strict"
import { test } from "node:test"

import type { SandboxRule } from "../../source/packages/local-exec/shell-core.ts"
import { EmptyWorkspaceIgnorePolicy } from "../../source/packages/local-exec/runtime-ignore-policy.ts"
import { PermissiveLocalExecAuthorization } from "../../source/packages/local-exec/runtime-permission-policy.ts"

test("the local executor's default workspace view has no ignored paths", async () => {
  const ignore = new EmptyWorkspaceIgnorePolicy()

  assert.equal(await ignore.isWorkspaceIgnored("/project/file.ts"), false)
  assert.equal(await ignore.isGitIgnored("/project/file.ts"), false)
  assert.equal(await ignore.isIgnoredByAny("/project/file.ts"), false)
  assert.deepEqual(await ignore.listWorkspaceIgnoreFilesByRoot("/project"), [])
  assert.equal(await ignore.isRepoBlocked("/project"), false)
  assert.deepEqual(await ignore.getWorkspaceIgnoreMapping(), {})
  assert.deepEqual(await ignore.getWorkspaceIgnoreMapping(), {})
  assert.deepEqual(await ignore.getGitIgnoreMapping(), {})
  assert.deepEqual(await ignore.getRepoBlockExcludeGlobs("/project"), [])
})

test("the executor's baseline permission policy allows operations without adding allowlist entries", async () => {
  const permissions = new PermissiveLocalExecAuthorization()
  const requestedPolicy = { type: "insecure_none" } satisfies SandboxRule

  assert.deepEqual(await permissions.shouldBlockShellCommand({}, "pwd", {}, requestedPolicy), {
    kind: "allow",
    policy: requestedPolicy,
  })
  assert.deepEqual(await permissions.shouldBlockShellCommand({}, "pwd", {}), {
    kind: "allow",
    policy: { type: "insecure_none" },
  })
  assert.deepEqual(await permissions.shouldEnforceShellInvariantBlocks({}, {}), { kind: "allow" })
  assert.equal(await permissions.shouldBlockRead("/project/file.ts"), false)
  assert.equal(await permissions.shouldBlockWrite({}, "/project/file.ts", "body"), false)
  assert.equal(await permissions.shouldBlockMcp({}, {}), false)
  assert.equal(await permissions.isShellCommandFullyAllowlisted({}, "pwd", {}), false)
  assert.equal(await permissions.isMcpFullyAllowlisted({}, {}), false)
  assert.equal(await permissions.isWebFetchFullyAllowlisted({}, {}), false)
  await permissions.addToAllowList({}, "shell", "pwd")
  await permissions.addToDenyList({}, "shell", "pwd")
})

test("the replaceable shell decision receives the original request", async () => {
  const permissions = new PermissiveLocalExecAuthorization()
  const seen: unknown[][] = []
  const policy = { type: "insecure_none" } satisfies SandboxRule
  permissions.setShellDecision(async (...args) => {
    seen.push(args)
    return { kind: "allow", policy }
  })

  assert.deepEqual(await permissions.shouldBlockShellCommand("context", "git status", { timeout: 9 }, policy), {
    kind: "allow",
    policy,
  })
  assert.deepEqual(seen, [["context", "git status", { timeout: 9 }, policy]])
})

test("allowlist probes can be replaced independently for shell and MCP requests", async () => {
  const permissions = new PermissiveLocalExecAuthorization()
  const calls: string[] = []
  permissions.setShellAllowlistProbe(async (_context, command, options) => {
    calls.push(`shell:${command}:${String((options as { source?: string }).source)}`)
    return true
  })
  permissions.setMcpAllowlistProbe(async (_context, options) => {
    calls.push(`mcp:${String((options as { server?: string }).server)}`)
    return false
  })

  assert.equal(await permissions.isShellCommandFullyAllowlisted({}, "pwd", { source: "test" }), true)
  assert.equal(await permissions.isMcpFullyAllowlisted({}, { server: "docs" }), false)
  assert.deepEqual(calls, ["shell:pwd:test", "mcp:docs"])
})
