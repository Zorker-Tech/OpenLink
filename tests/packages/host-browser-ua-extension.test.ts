import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts"
import { browserUaExtension, createBrowserUaExtension } from "../../source/host/extensions/browser-ua/extension.ts"

describe("browser user-agent extension", () => {
  it("declares auth and experiment dependencies", () => {
    assert.equal(browserUaExtension.kind, "host-extension")
    assert.equal(browserUaExtension.id, HostExtensions.BrowserUa)
    assert.deepEqual(browserUaExtension.dependencies, [HostExtensions.Auth, HostExtensions.Experiments])
  })

  it("stamps on startup and renewal, reconciles experiment changes, and unregisters both listeners", async () => {
    let accessToken: string | null = "initial-token"
    let renewalListener: ((event: { outcome: string }) => void) | undefined
    let experimentListener: (() => void) | undefined
    let removedRenewal = 0
    let removedExperiment = 0
    const writtenTokens: Array<string | null> = []
    const reconciliationCount: number[] = []
    const teardown: Array<() => void | Promise<void>> = []
    const extension = createBrowserUaExtension({
      createOwnerStampWriter: () => async (token) => { writtenTokens.push(token) },
      createKillSwitchReconciler: () => async () => { reconciliationCount.push(reconciliationCount.length + 1) },
    })

    extension.start({
      deps: {
        [HostExtensions.Auth]: {
          peekAccessToken: () => accessToken,
          subscribeToRenewal: (listener: (event: { outcome: string }) => void) => {
            renewalListener = listener
            return () => { removedRenewal += 1 }
          },
        },
        [HostExtensions.Experiments]: {
          isUaTokenKillSwitchEnabled: () => true,
          subscribe: (listener: () => void) => {
            experimentListener = listener
            return () => { removedExperiment += 1 }
          },
        },
      },
      host: { log: () => {} },
      onStop: (stop: () => void | Promise<void>) => { teardown.push(stop) },
    } as never)

    assert.deepEqual(writtenTokens, ["initial-token"])
    assert.deepEqual(reconciliationCount, [1])
    accessToken = "renewed-token"
    renewalListener?.({ outcome: "rejected" })
    assert.deepEqual(writtenTokens, ["initial-token"])
    renewalListener?.({ outcome: "renewed" })
    experimentListener?.()
    await Promise.resolve()
    assert.deepEqual(writtenTokens, ["initial-token", "renewed-token"])
    assert.deepEqual(reconciliationCount, [1, 2])
    assert.equal(teardown.length, 2)

    await Promise.all(teardown.map((stop) => stop()))
    assert.deepEqual([removedRenewal, removedExperiment], [1, 1])
  })
})
