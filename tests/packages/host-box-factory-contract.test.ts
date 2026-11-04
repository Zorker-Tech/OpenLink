import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { applySharedDesktop, createBox, formatBoxStartupSummary } from "../../source/host/boxes/box-factory.ts"
import { LoopbackBox } from "../../source/host/boxes/loopback-slate-box.ts"
import { SharedDesktopBox } from "../../source/host/boxes/shared-desktop-slate-box.ts"

describe("box factory policy", () => {
  it("creates the host's loopback box", () => {
    const box = createBox({ operations: {} } as never)
    assert.ok(box instanceof LoopbackBox)
    assert.deepEqual(box.describe(), { backend: "loopback" })
    assert.equal(box.primaryEndpoint().host, "127.0.0.1")
    assert.equal(box.primaryEndpoint().authToken, "local")
  })

  it("wraps only boxes whose capability allows more than one window", () => {
    const singleWindow = { maxWindows: () => 1 }
    const multiWindow = { maxWindows: () => 3 }

    assert.equal(applySharedDesktop(singleWindow as never), singleWindow)
    const shared = applySharedDesktop(multiWindow as never, { sharedBoxId: "team-box" })
    assert.ok(shared instanceof SharedDesktopBox)
    assert.equal(shared.inner, multiWindow)
    assert.equal(shared.sharedBoxId, "team-box")
    assert.equal(shared.maxWindowCount, 3)
  })

  it("states update and build mode without hiding either flag", () => {
    assert.equal(
      formatBoxStartupSummary({ autoUpdateEnabled: true, isPackaged: false }),
      "[slate-host] agent box backend: loopback (in-box); image: host's own container; auto-update: on; build: dev",
    )
    assert.match(formatBoxStartupSummary({ autoUpdateEnabled: false, isPackaged: true }), /auto-update: off; build: packaged$/)
  })
})
