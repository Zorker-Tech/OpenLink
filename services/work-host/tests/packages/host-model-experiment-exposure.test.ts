import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createModelExperimentExposureLatch, HYDRATION_WAIT_MS } from "../../source/host/telemetry/model-experiment-exposure.ts"
import type { SlateModelExperimentState } from "../../source/shared/node/experiments/slate-model-experiment.ts"

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe("model experiment exposure latch", () => {
  it("waits for hydrated assignment, records it once, and ignores later notes", async () => {
    let ready = false
    let hydrationWaits = 0
    let finishHydration: ((value: boolean) => void) | undefined
    let sdkCalls = 0
    const tracked: Array<{ name: string; properties: { arm: string } }> = []
    const latch = createModelExperimentExposureLatch({
      env: {},
      experiments: {
        hasHydratedExperimentUser: () => ready,
        waitForHydratedExperimentUser: (timeoutMs) => {
          hydrationWaits += 1
          assert.equal(timeoutMs, HYDRATION_WAIT_MS)
          return new Promise((resolve) => { finishHydration = resolve })
        },
        getSlateModelExperimentState: () => ({ active: true, arm: "control" }),
        logSlateModelExperimentExposure: () => { sdkCalls += 1; return true },
      },
      analytics: {
        canRecordEvents: () => true,
        trackEvent: (name, properties) => tracked.push({ name, properties }),
      },
    })

    latch.note()
    latch.note()
    assert.equal(tracked.length, 0)
    ready = true
    finishHydration?.(true)
    await tick()
    latch.note()
    await tick()

    assert.equal(sdkCalls, 1)
    assert.equal(hydrationWaits, 1)
    assert.deepEqual(tracked, [{ name: "slate.model_experiment.exposure", properties: { arm: "control" } }])
  })

  it("uses a valid environment arm without waiting for user hydration", async () => {
    let waitCalls = 0
    const tracked: Array<{ name: string; properties: { arm: string } }> = []
    const latch = createModelExperimentExposureLatch({
      env: { SLATE_MODEL_EXPERIMENT_OVERRIDE: "test" },
      experiments: {
        hasHydratedExperimentUser: () => false,
        waitForHydratedExperimentUser: async () => { waitCalls += 1; return false },
        getSlateModelExperimentState: () => undefined,
        logSlateModelExperimentExposure: () => false,
      },
      analytics: {
        canRecordEvents: () => true,
        trackEvent: (name, properties) => tracked.push({ name, properties }),
      },
    })

    latch.note()
    await tick()

    assert.equal(waitCalls, 0)
    assert.deepEqual(tracked, [{ name: "slate.model_experiment.exposure", properties: { arm: "treatment" } }])
  })

  it("keeps a refused or absent assignment retryable and does not report an inactive arm", async () => {
    let state: SlateModelExperimentState | null = null
    let sdkCalls = 0
    let permitSdkExposure = false
    const tracked: string[] = []
    const latch = createModelExperimentExposureLatch({
      env: {},
      experiments: {
        hasHydratedExperimentUser: () => true,
        waitForHydratedExperimentUser: async () => true,
        getSlateModelExperimentState: () => state,
        logSlateModelExperimentExposure: () => { sdkCalls += 1; return permitSdkExposure },
      },
      analytics: {
        canRecordEvents: () => true,
        trackEvent: (name) => tracked.push(name),
      },
    })

    latch.note()
    state = { active: true, arm: "treatment" }
    latch.note()
    assert.equal(sdkCalls, 1)
    assert.deepEqual(tracked, [])
    permitSdkExposure = true
    latch.note()
    latch.note()
    await tick()

    assert.equal(sdkCalls, 2)
    assert.deepEqual(tracked, ["slate.model_experiment.exposure"])
  })

  it("does not send analytics when it cannot record, but still counts the SDK exposure once", async () => {
    let sdkCalls = 0
    const latch = createModelExperimentExposureLatch({
      env: {},
      experiments: {
        hasHydratedExperimentUser: () => true,
        waitForHydratedExperimentUser: async () => true,
        getSlateModelExperimentState: () => ({ active: true, arm: "control" }),
        logSlateModelExperimentExposure: () => { sdkCalls += 1; return true },
      },
      analytics: { canRecordEvents: () => false, trackEvent: () => assert.fail("analytics is disabled") },
    })

    latch.note()
    latch.note()
    await tick()
    assert.equal(sdkCalls, 1)
  })
})
