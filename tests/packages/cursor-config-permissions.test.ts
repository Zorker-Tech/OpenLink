import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  PermissionsFileProvider,
} from "../../source/packages/cursor-config/permissions-file-provider.ts"
import {
  parsePermissionsAutoRunConfig,
  parseProjectPermissionsFileConfig,
} from "../../source/packages/cursor-config/project-permissions-file-provider.ts"
import {
  getConfigDir,
  HASH_LENGTH,
  MAX_FULL_PATH_LENGTH,
  MAX_PREFIX_LENGTH_BEFORE_HASH,
  MAX_SOCKET_PATH_LENGTH,
} from "../../source/packages/cursor-config/paths.ts"

// ---------------------------------------------------------------------------------------------
// where the configuration lives
// ---------------------------------------------------------------------------------------------

test("the configuration directory is the user's own unless the environment says otherwise", () => {
  assert.equal(getConfigDir({}), path.join(os.homedir(), ".slate"))
  assert.equal(getConfigDir({ SLATE_CONFIG_DIR: "/tmp/slate-config" }), "/tmp/slate-config")
  // An override that is only whitespace is not an override.
  assert.equal(getConfigDir({ SLATE_CONFIG_DIR: "   " }), path.join(os.homedir(), ".slate"))
  assert.equal(getConfigDir({ XDG_CONFIG_HOME: "/tmp/xdg" }), "/tmp/xdg/slate")
  // The platform's own override wins over the general one.
  assert.equal(getConfigDir({ SLATE_CONFIG_DIR: "/tmp/slate-config", XDG_CONFIG_HOME: "/tmp/xdg" }), "/tmp/slate-config")
})

test("the socket path limits leave room for a hash and the socket name", () => {
  assert.equal(HASH_LENGTH, 7)
  assert.equal(MAX_SOCKET_PATH_LENGTH, 104)
  // A prefixed path is shortened to fit, and a full path has to fit the socket name inside the limit.
  assert.equal(MAX_PREFIX_LENGTH_BEFORE_HASH + 1 + HASH_LENGTH + 1 + "worker.sock".length, MAX_SOCKET_PATH_LENGTH)
  assert.equal(MAX_FULL_PATH_LENGTH + "worker.sock".length + 1, MAX_SOCKET_PATH_LENGTH)
})

// ---------------------------------------------------------------------------------------------
// a project's own file
// ---------------------------------------------------------------------------------------------

test("a project file's auto-run policy is read from either spelling", () => {
  assert.deepEqual(parseProjectPermissionsFileConfig('{"autoRun":{"allow_instructions":["a"]}}'), {
    autoRun: { allowInstructions: ["a"], blockInstructions: undefined },
  })
  assert.deepEqual(parseProjectPermissionsFileConfig('{"autoReview":{"block_instructions":["b"]}}'), {
    autoRun: { allowInstructions: undefined, blockInstructions: ["b"] },
  })
})

test("comments and trailing commas are allowed in a file written by hand", () => {
  const parsed = parseProjectPermissionsFileConfig('{\n  // what may run unattended\n  "autoRun": { "allow_instructions": ["a"], },\n}')
  assert.deepEqual(parsed?.autoRun?.allowInstructions, ["a"])
})

test("a file that does not parse is not a configuration", () => {
  assert.equal(parseProjectPermissionsFileConfig("{ not json"), undefined)
  assert.equal(parseProjectPermissionsFileConfig('["a list, not an object"]'), undefined)
  assert.equal(parseProjectPermissionsFileConfig("null"), undefined)
})

test("a file with no auto-run policy has none", () => {
  assert.deepEqual(parseProjectPermissionsFileConfig('{"somethingElse":true}'), { autoRun: undefined })
})

test("an auto-run policy that is not an object has none", () => {
  assert.equal(parsePermissionsAutoRunConfig("a string"), undefined)
  assert.equal(parsePermissionsAutoRunConfig(["a list"]), undefined)
  assert.equal(parsePermissionsAutoRunConfig(null), undefined)
})

test("instructions that are not a list of strings are read as absent", () => {
  assert.deepEqual(parsePermissionsAutoRunConfig({ allow_instructions: "a string" }), {
    allowInstructions: undefined,
    blockInstructions: undefined,
  })
  // A list with the wrong kind of entry keeps the entries that are strings.
  assert.deepEqual(parsePermissionsAutoRunConfig({ allow_instructions: ["a", 7, null, "b"] })?.allowInstructions, ["a", "b"])
})

// ---------------------------------------------------------------------------------------------
// the user's own file
// ---------------------------------------------------------------------------------------------

/** A configuration file the test owns, removed when the test is done. */
function withFile(content: string | undefined, run: (filePath: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-permissions-"))
  const filePath = path.join(dir, "permissions.json")
  if (content !== undefined) fs.writeFileSync(filePath, content)
  return run(filePath).finally(() => fs.rmSync(dir, { recursive: true, force: true }))
}

test("a file that is not there is not a configuration", async () => {
  await withFile(undefined, async (filePath) => {
    assert.equal(await PermissionsFileProvider.load(filePath), undefined)
  })
})

test("the entries a user trusts become the platform's own permission syntax", async () => {
  await withFile(JSON.stringify({ terminalAllowlist: ["ls", "git status"], mcpAllowlist: ["github"] }), async (filePath) => {
    const provider = await PermissionsFileProvider.load(filePath)
    assert.notEqual(provider, undefined)
    const permissions = await provider!.getPermissions()
    assert.deepEqual(permissions.allow, ["Shell(ls)", "Shell(git status)", "Mcp(github)"])
    assert.deepEqual(permissions.deny, [])
    assert.equal(permissions.approvalMode, "unrestricted")
    assert.deepEqual(permissions.userConfiguredPolicy, { type: "insecure_none" })
  })
})

test("a field name a person capitalized differently is still read", async () => {
  await withFile(JSON.stringify({ MCPAllowlist: ["github"] }), async (filePath) => {
    const provider = await PermissionsFileProvider.load(filePath)
    assert.deepEqual((await provider!.getPermissions()).allow, ["Mcp(github)"])
  })
})

test("an auto-run policy is read and handed back", async () => {
  await withFile(JSON.stringify({ autoRun: { allow_instructions: ["run the tests"], block_instructions: ["never push"] } }), async (filePath) => {
    const provider = await PermissionsFileProvider.load(filePath)
    assert.deepEqual(provider!.getAutoRunInstructions(), {
      allowInstructions: ["run the tests"],
      blockInstructions: ["never push"],
    })
  })
})

test("a file with nothing configured is not a configuration", async () => {
  await withFile(JSON.stringify({ terminalAllowlist: [], mcpAllowlist: [] }), async (filePath) => {
    assert.equal(await PermissionsFileProvider.load(filePath), undefined)
  })
  await withFile(JSON.stringify({ somethingElse: true }), async (filePath) => {
    assert.equal(await PermissionsFileProvider.load(filePath), undefined)
  })
  await withFile("not json at all", async (filePath) => {
    assert.equal(await PermissionsFileProvider.load(filePath), undefined)
  })
  await withFile('"just a string"', async (filePath) => {
    assert.equal(await PermissionsFileProvider.load(filePath), undefined)
  })
})

test("entries that are not strings are left out", async () => {
  await withFile(JSON.stringify({ terminalAllowlist: ["ls", 7, null] }), async (filePath) => {
    const provider = await PermissionsFileProvider.load(filePath)
    assert.deepEqual((await provider!.getPermissions()).allow, ["Shell(ls)"])
  })
})

test("the instructions handed back are the provider's own copy", async () => {
  await withFile(JSON.stringify({ autoRun: { allow_instructions: ["a"] } }), async (filePath) => {
    const provider = await PermissionsFileProvider.load(filePath)
    const first = provider!.getAutoRunInstructions()
    ;(first.allowInstructions as string[]).push("added by the caller")
    assert.deepEqual(provider!.getAutoRunInstructions().allowInstructions, ["a"])
  })
})

test("the platform reads the file and does not write it", async () => {
  await withFile(JSON.stringify({ terminalAllowlist: ["ls"] }), async (filePath) => {
    const before = fs.readFileSync(filePath, "utf8")
    const provider = await PermissionsFileProvider.load(filePath)
    await provider!.updatePermissions(permissions => ({ ...permissions, allow: ["Shell(rm)"] }))
    assert.equal(fs.readFileSync(filePath, "utf8"), before)
  })
})

test("the file the provider looks for by default is the one in the config directory", () => {
  assert.equal(PermissionsFileProvider.getPermissionsFilePath(), path.join(getConfigDir(), "permissions.json"))
})
