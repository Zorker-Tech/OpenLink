import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts"
import {
  createHostUpgradeExtension,
  createMarkerStore,
  hostBundleWatchIntervalMs,
  hostBundleWatchJitterRatio,
  HOST_UPGRADE_MARKER_FORWARD_INTERVAL_MS,
  isHostBundleAutoUpdateEnabled,
} from "../../source/host/extensions/host-upgrade/extension.ts"
import {
  HOST_BUNDLE_WATCH_INTERVAL_MS,
  HOST_BUNDLE_WATCH_JITTER_RATIO,
} from "../../source/host/extensions/host-upgrade/host-bundle-upgrade.ts"

test("environment switches disable updates only for the documented false values", () => {
  assert.equal(isHostBundleAutoUpdateEnabled({}), true)
  for (const value of ["0", " false ", "NO"]) {
    assert.equal(isHostBundleAutoUpdateEnabled({ SLATE_BOX_AUTO_UPDATE: value }), false, value)
  }
  assert.equal(isHostBundleAutoUpdateEnabled({ SLATE_BOX_AUTO_UPDATE: "off" }), true)
})

test("watch timing values accept positive intervals and non-negative finite jitter", () => {
  assert.equal(hostBundleWatchIntervalMs({}), HOST_BUNDLE_WATCH_INTERVAL_MS)
  assert.equal(hostBundleWatchIntervalMs({ SLATE_BOX_UPDATE_WATCH_INTERVAL_MS: "2500" }), 2500)
  assert.equal(hostBundleWatchIntervalMs({ SLATE_BOX_UPDATE_WATCH_INTERVAL_MS: "0" }), HOST_BUNDLE_WATCH_INTERVAL_MS)
  assert.equal(hostBundleWatchIntervalMs({ SLATE_BOX_UPDATE_WATCH_INTERVAL_MS: "-2" }), HOST_BUNDLE_WATCH_INTERVAL_MS)
  assert.equal(hostBundleWatchJitterRatio({}), HOST_BUNDLE_WATCH_JITTER_RATIO)
  assert.equal(hostBundleWatchJitterRatio({ SLATE_BOX_UPDATE_WATCH_JITTER_RATIO: "0" }), 0)
  assert.equal(hostBundleWatchJitterRatio({ SLATE_BOX_UPDATE_WATCH_JITTER_RATIO: "0.25" }), 0.25)
  assert.equal(hostBundleWatchJitterRatio({ SLATE_BOX_UPDATE_WATCH_JITTER_RATIO: "-1" }), HOST_BUNDLE_WATCH_JITTER_RATIO)
})

test("the marker store reads, removes and tolerates a missing marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slate-upgrade-marker-"))
  const markerPath = join(directory, "marker.json")
  const store = createMarkerStore(markerPath)
  try {
    assert.equal(await store.readRaw(), null)
    await writeFile(markerPath, "{\"outcome\":\"applied\"}", "utf8")
    assert.equal(await store.readRaw(), "{\"outcome\":\"applied\"}")
    await store.deleteMarker()
    assert.equal(await readFile(markerPath, "utf8").then(() => true, () => false), false)
    await store.deleteMarker()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("the extension declares its peers, starts marker forwarding and disposes the watcher", async () => {
  const events: string[] = []
  const extension = createHostUpgradeExtension({
    isInBox: true,
    isAutoUpdateEnabled: false,
    markerStore: { readRaw: async () => null, deleteMarker: async () => {} },
    markerForwardPolicy: {
      start: () => {
        events.push("started")
        return { dispose: () => events.push("disposed") }
      },
    },
  })
  const deps = {
    [HostExtensions.Automations]: { suspendWakes: async () => {} },
    [HostExtensions.CrossUserSharing]: { prepareForUpgrade() {} },
    [HostExtensions.Telemetry]: {
      logs: {
        reportHostUpgrade() {},
        reportHostUpgradeConfirmed: async () => true,
      },
    },
    [HostExtensions.Transcript]: {
      quiesceForUpgrade: async () => undefined,
      resumeInterruptedUpgradeTurns: async () => {},
    },
  }
  const teardowns: Array<() => void | Promise<void>> = []
  const service = await extension.start({
    deps,
    host: {},
    onStop: (teardown: () => void | Promise<void>) => teardowns.push(teardown),
  } as never)

  assert.deepEqual([extension.id, extension.dependencies], [
    HostExtensions.HostUpgrade,
    [HostExtensions.Automations, HostExtensions.CrossUserSharing, HostExtensions.Telemetry, HostExtensions.Transcript],
  ])
  assert.equal(HOST_UPGRADE_MARKER_FORWARD_INTERVAL_MS, 5 * 60_000)
  assert.equal(service.isAutoUpdateEnabled, false)
  assert.deepEqual(events, ["started"])
  assert.equal(teardowns.length, 1)
  await teardowns[0]?.()
  assert.deepEqual(events, ["started", "disposed"])
})
