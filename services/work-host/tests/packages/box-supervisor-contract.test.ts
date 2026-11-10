import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  BOX_AGENT_DATA_ROOT,
  BOX_HOST_DIR,
  BOX_HOST_ENTRY,
  BOX_HOST_VERSION_PATH,
  BOX_SUPERVISOR_ACKS_DIR,
  BOX_SUPERVISOR_COMMAND_PART_PATH,
  BOX_SUPERVISOR_COMMAND_PATH,
  BOX_SUPERVISOR_DESKTOP_HEALTH_PATH,
  BOX_SUPERVISOR_DIR,
  BOX_SUPERVISOR_STAGED_BUNDLE_PART_PATH,
  BOX_SUPERVISOR_STAGED_BUNDLE_PATH,
  BOX_SUPERVISOR_STATUS_PATH,
  HOST_UPGRADE_MAX_DEFER_MS,
  buildBoxSupervisorCommand,
  isHostUpgradeAvailable,
  serializeBoxSupervisorCommand,
} from "../../source/packages/constants/box-supervisor.ts"

describe("box supervisor contract", () => {
  it("keeps shared filesystem paths under the declared supervisor and host roots", () => {
    assert.equal(BOX_SUPERVISOR_DIR, "/tmp/slate-supervisor")
    assert.equal(BOX_SUPERVISOR_COMMAND_PATH, `${BOX_SUPERVISOR_DIR}/command.json`)
    assert.equal(BOX_SUPERVISOR_COMMAND_PART_PATH, `${BOX_SUPERVISOR_COMMAND_PATH}.part`)
    assert.equal(BOX_SUPERVISOR_STATUS_PATH, `${BOX_SUPERVISOR_DIR}/status.json`)
    assert.equal(BOX_SUPERVISOR_ACKS_DIR, `${BOX_SUPERVISOR_DIR}/acks`)
    assert.equal(BOX_SUPERVISOR_STAGED_BUNDLE_PATH, `${BOX_SUPERVISOR_DIR}/incoming-host-bundle.tgz`)
    assert.equal(BOX_SUPERVISOR_STAGED_BUNDLE_PART_PATH, `${BOX_SUPERVISOR_STAGED_BUNDLE_PATH}.part`)
    assert.equal(BOX_SUPERVISOR_DESKTOP_HEALTH_PATH, `${BOX_SUPERVISOR_DIR}/desktop-health.json`)
    assert.equal(BOX_AGENT_DATA_ROOT, "/home/box/slate-data")
    assert.equal(BOX_HOST_ENTRY, `${BOX_HOST_DIR}/host-main.cjs`)
    assert.equal(BOX_HOST_VERSION_PATH, `${BOX_HOST_DIR}/version`)
  })

  it("keeps upgrade-only fields off restart commands", () => {
    const restart = buildBoxSupervisorCommand({
      id: "restart-1",
      kind: "restart",
      nowMs: 1_000,
      reason: "operator",
      mode: "staged",
      version: "2.0.0",
      bundlePath: "/tmp/update.tgz",
      forceNow: true,
    })

    assert.deepEqual(restart, {
      id: "restart-1",
      kind: "restart",
      issuedAtMs: 1_000,
      reason: "operator",
    })
    assert.equal(serializeBoxSupervisorCommand(restart), JSON.stringify(restart))
  })

  it("includes upgrade fields only when present and enables force only when requested", () => {
    const upgrade = buildBoxSupervisorCommand({
      id: "upgrade-1",
      kind: "upgrade",
      nowMs: 2_000,
      mode: "staged",
      version: "2.0.0",
      bundlePath: "/tmp/update.tgz",
      forceNow: true,
    })
    assert.deepEqual(upgrade, {
      id: "upgrade-1",
      kind: "upgrade",
      issuedAtMs: 2_000,
      mode: "staged",
      version: "2.0.0",
      bundlePath: "/tmp/update.tgz",
      forceNow: true,
    })
    assert.equal(serializeBoxSupervisorCommand(upgrade), JSON.stringify(upgrade))

    const defaultUpgrade = buildBoxSupervisorCommand({ id: "upgrade-2", kind: "upgrade", nowMs: 3_000 })
    assert.deepEqual(defaultUpgrade, { id: "upgrade-2", kind: "upgrade", issuedAtMs: 3_000 })
    assert.equal("forceNow" in defaultUpgrade, false)
  })

  it("treats only a nonempty different target version as an available upgrade", () => {
    assert.equal(isHostUpgradeAvailable("1.0.0", "1.0.1"), true)
    assert.equal(isHostUpgradeAvailable("1.0.0", "1.0.0"), false)
    assert.equal(isHostUpgradeAvailable("1.0.0", null), false)
    assert.equal(isHostUpgradeAvailable("1.0.0", undefined), false)
    assert.equal(isHostUpgradeAvailable("1.0.0", ""), false)
    assert.equal(HOST_UPGRADE_MAX_DEFER_MS, 6 * 60 * 60 * 1_000)
  })
})
