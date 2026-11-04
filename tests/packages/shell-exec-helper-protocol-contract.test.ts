import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildSandboxArgv,
  buildSandboxChildEnvironment,
  buildSandboxPolicyEnvelope,
  buildSandboxSpawnOptions,
  projectSandboxCommand,
  resolveNetworkPolicyForFile,
  type HelperNetworkPolicy,
  type HelperSandboxPolicy,
} from "../../source/packages/shell-exec/sandbox/helper-protocol.ts"

test("network policy projection omits disabled policies and retains actionable exceptions", () => {
  assert.equal(resolveNetworkPolicyForFile({ type: "insecure_none", networkPolicy: { version: 1, default: "allow", deny: ["private"] } }), undefined)
  assert.equal(resolveNetworkPolicyForFile({ type: "workspace_readwrite" }), undefined)
  assert.equal(resolveNetworkPolicyForFile({ type: "workspace_readwrite", networkPolicy: { version: 1, default: "deny" } }), undefined)
  assert.equal(resolveNetworkPolicyForFile({ type: "workspace_readwrite", networkPolicy: { version: 1, default: "allow" } }), undefined)
  assert.deepEqual(resolveNetworkPolicyForFile({
    type: "workspace_readonly",
    networkPolicy: { version: 1, default: "allow", deny: ["private"], logging: { level: "summary" } },
  }), { version: 1, default: "allow", deny: ["private"], logging: { level: "summary" } })
  assert.deepEqual(resolveNetworkPolicyForFile({
    type: "workspace_readwrite",
    networkPolicy: { version: 1, allow: ["docs.invalid"] },
  }), { version: 1, allow: ["docs.invalid"] })
})

test("the envelope preserves the sandbox policy and includes strictness only when disabled", () => {
  const sandbox = { type: "workspace_readwrite", readBoundary: "workspace" }
  const networkPolicy: HelperNetworkPolicy = { version: 1, default: "allow", deny: ["private"] }
  const envelope = buildSandboxPolicyEnvelope(sandbox, {
    type: "workspace_readwrite",
    networkPolicy,
    networkPolicyStrict: false,
  })
  assert.equal(envelope.sandbox, sandbox)
  assert.deepEqual(envelope.networkPolicy, networkPolicy)
  assert.notEqual(envelope.networkPolicy, networkPolicy)
  assert.equal(envelope.networkPolicyStrict, false)

  const ordinary = buildSandboxPolicyEnvelope(sandbox, { type: "workspace_readwrite", networkPolicyStrict: true })
  assert.deepEqual(ordinary, { sandbox })
})

test("the helper argv keeps the policy boundary before the program and its arguments", () => {
  assert.deepEqual(buildSandboxArgv("/tmp/policy.json", "echo", ["hello", "world"]), [
    "--policy", "/tmp/policy.json", "--", "echo", "hello", "world",
  ])
})

test("shell projection leaves direct invocations intact and selects the platform shell form", () => {
  const args = ["file name", "--safe"]
  const direct = projectSandboxCommand("tool", args, false)
  assert.equal(direct.command, "tool")
  assert.equal(direct.args, args)

  const projected = projectSandboxCommand("tool", args, "/custom/shell")
  assert.equal(projected.command, "/custom/shell")
  assert.deepEqual(projected.args, [process.platform === "win32" ? "/c" : "-c", "tool file name --safe"])
  const defaultShell = projectSandboxCommand("tool", [], true)
  assert.equal(defaultShell.command, process.platform === "win32" ? "cmd.exe" : "/bin/sh")
})

test("child environments apply platform socket filtering without mutating the caller input", () => {
  const input = { KEEP: "caller", SSH_AUTH_SOCK: "/tmp/agent.sock", SLATE_SANDBOX: "caller-value" }
  const environment = buildSandboxChildEnvironment(input)
  assert.equal(environment.KEEP, "caller")
  assert.equal(environment.SLATE_SANDBOX, "native")
  assert.equal(input.SLATE_SANDBOX, "caller-value")
  if (process.platform === "linux") assert.equal(environment.SSH_AUTH_SOCK, undefined)
  else assert.equal(environment.SSH_AUTH_SOCK, "/tmp/agent.sock")
})

test("spawn settings use the chosen working directory, output streams and filtered environment", () => {
  const options = buildSandboxSpawnOptions({ cwd: "", env: { KEEP: "yes" }, stdio: "ignore" }, "/execution")
  assert.equal(options.cwd, "/execution")
  assert.equal(options.env?.SLATE_SANDBOX, "native")
  assert.equal(options.env?.KEEP, "yes")
  assert.equal(options.stdio, "ignore")
  assert.deepEqual(buildSandboxSpawnOptions({}, "/fallback").stdio, ["pipe", "pipe", "pipe"])
})
