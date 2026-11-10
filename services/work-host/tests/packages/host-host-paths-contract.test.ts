import assert from "node:assert/strict"
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  SLATE_BOX_DATA_ROOT,
  SLATE_BOX_MODEL_VISIBLE_DATA_ROOT,
  SLATE_DATA_DIRNAME,
  SLATE_DATA_ROOT_ENV,
  SLATE_PRODUCTION_DATA_DIRNAME,
  SLATE_USER_DATA_DIR_ENV,
  USER_DATA_DIR_FLAG,
  ensureDataRootAlias,
  getGatewayDiscoveryPath,
  getHostCrashMarkerPath,
  getHostLockPath,
  getHostSecretsPath,
  getHostUpgradeMarkerPath,
  getSlateProductionRootDir,
  getSlateRootDir,
  readUserDataDirArg,
  reanchorSlatePath,
  resolveSlateDataRootOverride,
  resolveSlateUserDataDir,
  toModelVisiblePath,
} from "../../source/host/host-paths.ts"

function withEnvironment(values: Record<string, string | undefined>, check: () => void): void {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]))
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    check()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test("the command line data folder wins over the environment and relative folders use the caller's directory", () => {
  assert.equal(readUserDataDirArg(["--other", "value", USER_DATA_DIR_FLAG, "../profile"]), "../profile")
  assert.equal(readUserDataDirArg([`${USER_DATA_DIR_FLAG}=/absolute/profile`]), "/absolute/profile")
  assert.equal(readUserDataDirArg([USER_DATA_DIR_FLAG, "--next"]), null)
  assert.equal(resolveSlateUserDataDir([USER_DATA_DIR_FLAG, "../profile"], { [SLATE_USER_DATA_DIR_ENV]: "/env/profile" }, "/work/app"), "/work/profile")
  assert.equal(resolveSlateUserDataDir([], { [SLATE_USER_DATA_DIR_ENV]: "profile" }, "/work/app"), "/work/app/profile")
  assert.equal(resolveSlateUserDataDir([], { [SLATE_USER_DATA_DIR_ENV]: "  " }, "/work/app"), null)
})

test("the state root accepts absolute overrides and otherwise follows the chosen data directory or build", () => {
  assert.equal(resolveSlateDataRootOverride({ [SLATE_DATA_ROOT_ENV]: "/shared/state" }), "/shared/state")
  assert.equal(resolveSlateDataRootOverride({ [SLATE_DATA_ROOT_ENV]: "relative/state" }), null)
  assert.equal(getSlateProductionRootDir("/home/alex"), join("/home/alex", SLATE_PRODUCTION_DATA_DIRNAME))

  withEnvironment({ [SLATE_DATA_ROOT_ENV]: "/explicit/root", [SLATE_USER_DATA_DIR_ENV]: "/user/profile" }, () => {
    assert.equal(getSlateRootDir("/home/alex"), "/explicit/root")
  })
  withEnvironment({ [SLATE_DATA_ROOT_ENV]: undefined, [SLATE_USER_DATA_DIR_ENV]: "/user/profile" }, () => {
    assert.equal(getSlateRootDir("/home/alex"), join("/user/profile", SLATE_DATA_DIRNAME))
  })
  withEnvironment({ [SLATE_DATA_ROOT_ENV]: undefined, [SLATE_USER_DATA_DIR_ENV]: undefined, SLATE_PACKAGED: "1", SLATE_LAB: "1" }, () => {
    assert.equal(getSlateRootDir("/home/alex"), join("/home/alex", ".slate", "slate-lab"))
  })
})

test("model-visible and reanchored paths keep their roots and reject traversal segments", () => {
  assert.equal(toModelVisiblePath(`${SLATE_BOX_DATA_ROOT}/agents/a`), `${SLATE_BOX_MODEL_VISIBLE_DATA_ROOT}/agents/a`)
  assert.equal(toModelVisiblePath("/home/box/slate-database/agents/a"), "/home/box/slate-database/agents/a")

  withEnvironment({ [SLATE_DATA_ROOT_ENV]: "/new/slate-root" }, () => {
    assert.equal(reanchorSlatePath("/old/.slate/agents/agent-1/profile.json"), "/new/slate-root/agents/agent-1/profile.json")
    assert.equal(reanchorSlatePath("/old/.slate/agents/../outside.json"), "/old/.slate/agents/../outside.json")
    assert.equal(reanchorSlatePath("/unrelated/path.json"), "/unrelated/path.json")
    assert.equal(getGatewayDiscoveryPath("/unused"), "/new/slate-root/gateway.json")
    assert.equal(getHostLockPath("/unused"), "/new/slate-root/host.lock")
    assert.equal(getHostSecretsPath("/unused"), "/new/slate-root/host-secrets.json")
    assert.equal(getHostUpgradeMarkerPath("/unused"), "/new/slate-root/.slate-host-upgrade.json")
    assert.equal(getHostCrashMarkerPath("/unused"), "/new/slate-root/.slate-host-crash.json")
  })
})

test("the root alias is created or repaired without replacing a real path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slate-data-root-alias-"))
  const alias = join(directory, "alias")
  const firstRoot = join(directory, "state-one")
  const secondRoot = join(directory, "state-two")
  try {
    await ensureDataRootAlias({ dataRoot: firstRoot, aliasPath: alias })
    assert.equal(readlinkSync(alias), firstRoot)
    await ensureDataRootAlias({ dataRoot: firstRoot, aliasPath: alias })
    assert.equal(readlinkSync(alias), firstRoot)

    rmSync(alias)
    writeFileSync(alias, "user file")
    await ensureDataRootAlias({ dataRoot: secondRoot, aliasPath: alias })
    assert.equal(lstatSync(alias).isFile(), true)
    assert.equal(readFileSync(alias, "utf8"), "user file")

    rmSync(alias)
    symlinkSync(firstRoot, alias)
    await ensureDataRootAlias({ dataRoot: secondRoot, aliasPath: alias })
    assert.equal(readlinkSync(alias), secondRoot)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
