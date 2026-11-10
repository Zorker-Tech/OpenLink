import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { PermissionsFileProvider } from "../../source/packages/config/permissions-file-provider.ts"

test("the machine permissions file accepts JSONC, matches field names without case and prefers the newer review policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-permissions-file-"))
  const filePath = join(root, "permissions.json")
  try {
    writeFileSync(filePath, `{
      // The two allowlists become native permission entries.
      "TerminalAllowlist": ["ls", "git status", 7,],
      "MCPAllowlist": ["knowledge",],
      "autoRun": { "allow_instructions": ["old policy"] },
      "AutoReview": {
        "allow_instructions": ["review small changes"],
        "block_instructions": ["never remove user data"],
      },
    }`)

    const provider = await PermissionsFileProvider.load(filePath)
    assert.ok(provider)
    assert.deepEqual(await provider.getPermissions(), {
      allow: ["Shell(ls)", "Shell(git status)", "Mcp(knowledge)"],
      deny: [],
      approvalMode: "unrestricted",
      userConfiguredPolicy: { type: "insecure_none" },
    })
    assert.deepEqual(provider.getAutoRunInstructions(), {
      allowInstructions: ["review small changes"],
      blockInstructions: ["never remove user data"],
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
