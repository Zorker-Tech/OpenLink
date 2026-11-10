import assert from "node:assert/strict"
import { test } from "node:test"

import { forcedShellSandboxPolicy, isForcedShellEgressEnabled } from "../../source/packages/local-exec/forced-egress.ts"

const ENVIRONMENT_KEYS = [
  "SLATE_FORCED_SHELL_EGRESS",
  "SLATE_FORCED_SHELL_EGRESS_DEPENDENCY_REGEX",
  "SLATE_FORCED_SHELL_EGRESS_EXTRA_DEPENDENCY_REGEX",
  "SLATE_FORCED_SHELL_EGRESS_SOURCE_REGEX",
  "SLATE_FORCED_SHELL_EGRESS_EXTRA_SOURCE_REGEX",
  "SLATE_FORCED_SHELL_EGRESS_NETWORK_DEFAULT",
  "SLATE_FORCED_SHELL_EGRESS_DENY_DOMAINS",
  "SLATE_FORCED_SHELL_EGRESS_DEPENDENCY_DENY_DOMAINS",
  "SLATE_FORCED_SHELL_EGRESS_ALLOW_DOMAINS",
  "SLATE_FORCED_SHELL_EGRESS_WRITABLE_PATHS",
] as const

test("forced shell egress fails closed unless every executable is an allowed dependency command", () => {
  const original = new Map(ENVIRONMENT_KEYS.map(key => [key, process.env[key]]))
  const logs: string[] = []
  const previousError = console.error
  console.error = ((...values: unknown[]) => logs.push(values.join(" "))) as typeof console.error

  try {
    process.env.SLATE_FORCED_SHELL_EGRESS = "1"
    process.env.SLATE_FORCED_SHELL_EGRESS_DEPENDENCY_REGEX = "^(?:npm|pnpm)(\\s|$)"
    process.env.SLATE_FORCED_SHELL_EGRESS_SOURCE_REGEX = "^git$"
    process.env.SLATE_FORCED_SHELL_EGRESS_NETWORK_DEFAULT = "allow"
    process.env.SLATE_FORCED_SHELL_EGRESS_DENY_DOMAINS = "blocked.example, .internal"
    process.env.SLATE_FORCED_SHELL_EGRESS_DEPENDENCY_DENY_DOMAINS = "none"
    process.env.SLATE_FORCED_SHELL_EGRESS_ALLOW_DOMAINS = "trusted.example"
    process.env.SLATE_FORCED_SHELL_EGRESS_WRITABLE_PATHS = "/tmp:relative:/var/tmp"

    assert.equal(isForcedShellEgressEnabled(), true)
    assert.deepEqual(forcedShellSandboxPolicy("CI=1 npm install", {
      executableCommands: [{ name: "npm", fullText: "CI=1 npm install" }],
    }), {
      type: "workspace_readwrite",
      additionalReadwritePaths: ["/tmp", "/var/tmp"],
      networkPolicy: { version: 1, default: "allow" },
      skipStatsigDefaults: true,
      enableSharedBuildCache: true,
    })

    const fallback = forcedShellSandboxPolicy("npm install", {
      executableCommands: [{ name: "npm", fullText: "npm install && curl example.test" }],
    })
    assert.deepEqual(fallback.networkPolicy, {
      version: 1,
      default: "allow",
      allow: ["127.0.0.0/8", "::1/128", "localhost", "trusted.example"],
      deny: ["blocked.example", ".internal"],
    })
    assert.equal(fallback.networkPolicyStrict, true)

    for (const [command, parsing] of [
      ["npm install $(curl example.test)", { executableCommands: [{ name: "npm", fullText: "npm install" }] }],
      ["npm install", { parsingFailed: true, executableCommands: [{ name: "npm" }] }],
      ["npm install", undefined],
      ["git", { executableCommands: [{ name: "git", fullText: "git" }] }],
      ["npm install", { executableCommands: [{ name: "npm", fullText: "npm install" }, { name: "curl", fullText: "curl example.test" }] }],
    ] as const) {
      const policy = forcedShellSandboxPolicy(command, parsing)
      assert.equal(policy.networkPolicyStrict, true, command)
      assert.equal(policy.networkPolicy.default, "allow", command)
    }

    process.env.SLATE_FORCED_SHELL_EGRESS = "off"
    assert.equal(isForcedShellEgressEnabled(), true, "the process reads its feature switch once")
    assert.equal(logs.some(message => message.includes("ignoring 1 non-absolute path")), true)
  } finally {
    console.error = previousError
    for (const key of ENVIRONMENT_KEYS) {
      const value = original.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
