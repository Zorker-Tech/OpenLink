import assert from "node:assert/strict"
import { test } from "node:test"

import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts"
import { realClock } from "../../source/host/extensions/scheduling.ts"
import { startBoxStoreSyncExtension } from "../../source/host/boxes/box-store-sync/box-store-sync-extension-composition.ts"
import type { BoxStoreSyncServiceDependencies } from "../../source/host/boxes/box-store-sync/box-store-sync-service-contracts.ts"

test("the extension hands its host dependencies to the service and disposes it on stop", async () => {
  const order: string[] = []
  const stopHandlers: Array<() => void | Promise<void>> = []
  const diagnostics: unknown[] = []
  const auth = { name: "auth-port" }
  const sourceMap = { async getOrCreateBoxStore() { return { sourceId: "store-1" } } }
  const logs = {
    reportHostExtensionDiagnostic(value: unknown) { diagnostics.push(value) },
    reportBoxStoreSyncCycle() {},
    reportChromeSessionStage() {},
    reportBoxStoreManifestConflict() {},
    reportBoxStoreDbCapture() {},
  }
  const host = { isIdle: () => true, log: (message: string) => order.push(message) }
  let captured: BoxStoreSyncServiceDependencies | undefined
  const api = { status: "ready" }
  const context = {
    deps: {
      [HostExtensions.Auth]: auth,
      [HostExtensions.SourceMap]: sourceMap,
      [HostExtensions.Telemetry]: { logs },
    },
    host,
    onStop(handler: () => void | Promise<void>) { stopHandlers.push(handler) },
  }

  const extensionApi = startBoxStoreSyncExtension(context as never, {
    pinDiagnosticsReporter: reporter => {
      order.push("diagnostics")
      reporter({ phase: "test" })
    },
    createService: dependencies => {
      order.push("create")
      captured = dependencies
      return {
        api,
        start() { order.push("start") },
        async dispose() { order.push("dispose") },
      }
    },
  })

  assert.equal(extensionApi, api)
  assert.deepEqual(order, ["diagnostics", "create", "start"])
  assert.deepEqual(diagnostics, [{ phase: "test" }])
  assert.equal(captured?.auth, auth)
  assert.equal(captured?.sourceMap, sourceMap)
  assert.equal(captured?.telemetry, logs)
  assert.equal(captured?.isIdle, host.isIdle)
  assert.equal(captured?.clock, realClock)
  assert.ok(captured?.polling)
  assert.ok(captured?.storeDbDebounce)
  assert.ok(captured?.chromeSessionDebounce)
  assert.ok(captured?.manifestRetry)
  assert.ok(captured?.chromeStageRetry)
  assert.equal(stopHandlers.length, 1)

  await stopHandlers[0]?.()
  assert.deepEqual(order, ["diagnostics", "create", "start", "dispose"])
})
