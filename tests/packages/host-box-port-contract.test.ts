import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  BoxEnvironmentSyncUnsupportedError,
  BoxMcpUnsupportedError,
  boxNotReadyMessageForError,
  isNoMonitorComputerUseExecutor,
  isPrimaryWindowIndex,
  noMonitorComputerUseExecutor,
  SLATE_BOX_FIRST_FORK_WINDOW_INDEX,
  SLATE_BOX_NO_MONITOR_AVAILABLE_MESSAGE,
  SLATE_BOX_NOT_READY_MESSAGE,
  SLATE_BOX_NOT_RESPONDING_MESSAGE,
  SLATE_BOX_PRIMARY_WINDOW_INDEX,
  SlateBoxDaemonUnreachableError,
  SlateBoxNoMonitorAvailableError,
} from "../../source/host/ports/box.ts"

describe("host box port", () => {
  it("maps monitor, timeout, crash and other failures to the user-facing readiness message", () => {
    assert.equal(boxNotReadyMessageForError(new SlateBoxNoMonitorAvailableError()), SLATE_BOX_NO_MONITOR_AVAILABLE_MESSAGE)
    assert.equal(boxNotReadyMessageForError(new SlateBoxDaemonUnreachableError("timeout", "late")), SLATE_BOX_NOT_RESPONDING_MESSAGE)
    assert.equal(boxNotReadyMessageForError(new SlateBoxDaemonUnreachableError("crash", "stopped")), SLATE_BOX_NOT_RESPONDING_MESSAGE)
    assert.equal(boxNotReadyMessageForError(new SlateBoxDaemonUnreachableError("refused", "refused")), SLATE_BOX_NOT_READY_MESSAGE)
    assert.equal(boxNotReadyMessageForError(new Error("other")), SLATE_BOX_NOT_READY_MESSAGE)
  })

  it("uses a stable no-monitor executor sentinel with a typed refusal", async () => {
    assert.equal(isNoMonitorComputerUseExecutor(noMonitorComputerUseExecutor), true)
    assert.equal(isNoMonitorComputerUseExecutor({ execute: noMonitorComputerUseExecutor.execute }), false)
    await assert.rejects(noMonitorComputerUseExecutor.execute(), SlateBoxNoMonitorAvailableError)
  })

  it("keeps the primary window before the first fork window", () => {
    assert.equal(SLATE_BOX_PRIMARY_WINDOW_INDEX, 1)
    assert.equal(SLATE_BOX_FIRST_FORK_WINDOW_INDEX, 2)
    assert.equal(isPrimaryWindowIndex(0), true)
    assert.equal(isPrimaryWindowIndex(1), true)
    assert.equal(isPrimaryWindowIndex(2), false)
  })

  it("names unsupported box capabilities explicitly", () => {
    assert.equal(new BoxEnvironmentSyncUnsupportedError().message, "This box does not support environment sync.")
    assert.equal(new BoxMcpUnsupportedError().message, "This box does not support running MCP servers.")
  })
})
