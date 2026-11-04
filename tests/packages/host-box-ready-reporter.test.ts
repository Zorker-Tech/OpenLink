import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  BOX_READY_REPORT_ATTEMPTS,
  BOX_READY_REPORT_RETRY_MS,
  reportBoxReady,
} from "../../source/host/box-ready-reporter.ts"

describe("reporting that a box is ready", () => {
  it("does nothing unless the process has a valid boot identity", async () => {
    let reads = 0
    let reports = 0
    await reportBoxReady({
      environment: {},
      readMarker: async () => { reads += 1; return null },
      reportConfirmed: async () => { reports += 1; return true },
    })
    await reportBoxReady({
      environment: { SLATE_BOX_BOOT_ID: "boot", SLATE_BOX_BOOT_STARTED_AT_MS: "bad" },
      readMarker: async () => { reads += 1; return null },
      reportConfirmed: async () => { reports += 1; return true },
    })
    assert.equal(reads, 0)
    assert.equal(reports, 0)
  })

  it("skips a boot already recorded and skips when telemetry cannot report", async () => {
    let reports = 0
    let writes = 0
    const common = {
      environment: { SLATE_BOX_BOOT_ID: "boot-1", SLATE_BOX_BOOT_STARTED_AT_MS: "1000" },
      readMarker: async () => "boot-1",
      writeMarker: async () => { writes += 1 },
      reportConfirmed: async () => { reports += 1; return true },
    }
    await reportBoxReady(common)
    const { reportConfirmed: _reportConfirmed, ...withoutReporter } = common
    await reportBoxReady({ ...withoutReporter, readMarker: async () => null })
    assert.equal(reports, 0)
    assert.equal(writes, 0)
  })

  it("reports a non-negative duration and writes the boot marker after confirmation", async () => {
    const reports: Array<{ stage: string; durationMs: number }> = []
    const markers: string[] = []
    await reportBoxReady({
      environment: { SLATE_BOX_BOOT_ID: "boot-2", SLATE_BOX_BOOT_STARTED_AT_MS: "1000" },
      now: () => 990,
      readMarker: async () => null,
      reportConfirmed: async (report) => { reports.push(report); return true },
      writeMarker: async (bootId) => { markers.push(bootId) },
    })
    assert.deepEqual(reports, [{ stage: "ready", durationMs: 0 }])
    assert.deepEqual(markers, ["boot-2"])
  })

  it("retries an unconfirmed report a bounded number of times", async () => {
    const attempts: number[] = []
    const waits: number[] = []
    const markers: string[] = []
    await reportBoxReady({
      environment: { SLATE_BOX_BOOT_ID: "boot-3", SLATE_BOX_BOOT_STARTED_AT_MS: "1000" },
      now: () => 1100,
      readMarker: async () => null,
      reportConfirmed: async () => { attempts.push(attempts.length + 1); return false },
      writeMarker: async (bootId) => { markers.push(bootId) },
      wait: async (milliseconds) => { waits.push(milliseconds) },
    })
    assert.equal(attempts.length, BOX_READY_REPORT_ATTEMPTS)
    assert.deepEqual(waits, [BOX_READY_REPORT_RETRY_MS, BOX_READY_REPORT_RETRY_MS])
    assert.deepEqual(markers, [])
  })

  it("does not retry a confirmed report when writing its marker fails", async () => {
    let attempts = 0
    await reportBoxReady({
      environment: { SLATE_BOX_BOOT_ID: "boot-4", SLATE_BOX_BOOT_STARTED_AT_MS: "1000" },
      readMarker: async () => null,
      reportConfirmed: async () => { attempts += 1; return true },
      writeMarker: async () => { throw new Error("read-only") },
      wait: async () => { throw new Error("the report was already confirmed") },
    })
    assert.equal(attempts, 1)
  })
})
