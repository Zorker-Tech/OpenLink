import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SettingsService } from "../../source/host/settings/settings-service.ts"

const temporaryDirectories: string[] = []

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
})

function service(): SettingsService {
  const directory = mkdtempSync(join(tmpdir(), "slate-host-settings-"))
  temporaryDirectories.push(directory)
  return new SettingsService(join(directory, "settings.json"))
}

test("settings patches update valid fields and publish only their matching change signals", () => {
  const settings = service()
  const changes: Array<{ readonly fields: string[] }> = []
  const timeZones: Array<string | undefined> = []
  const featureFlags: Array<Record<string, boolean>> = []
  settings.subscribeToChanges(event => changes.push(event))
  settings.subscribeToUserTimeZone(value => timeZones.push(value))
  settings.subscribeToFeatureFlagOverrides(value => featureFlags.push(value))

  const result = settings.setHostSettings({
    userTimeZone: "America/New_York",
    pinnedAgentIds: ["agent-1"],
    featureFlagOverrides: { newComposer: true },
    inferenceProvider: "codex",
  })

  assert.equal(settings.getUserTimeZone(), "America/New_York")
  assert.deepEqual(result.pinnedAgentIds, ["agent-1"])
  assert.equal(settings.getInferenceProvider(), "codex")
  assert.deepEqual(timeZones, ["America/New_York"])
  assert.deepEqual(featureFlags, [{ newComposer: true }])
  assert.deepEqual(changes, [{ fields: ["userTimeZone", "pinnedAgentIds", "featureFlagOverrides", "inferenceProvider"] }])

  settings.setHostSettings({ userTimeZone: "not/a/time-zone" })
  assert.equal(settings.getUserTimeZone(), "America/New_York")
  assert.deepEqual(timeZones, ["America/New_York"])
  assert.deepEqual(featureFlags, [{ newComposer: true }], "an unrelated update does not rebroadcast feature flags")
  assert.deepEqual(changes.at(-1), { fields: ["userTimeZone"] })
})
