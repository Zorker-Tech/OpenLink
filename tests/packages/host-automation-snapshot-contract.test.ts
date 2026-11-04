import assert from "node:assert/strict"
import test from "node:test"
import type { AutomationRecord } from "../../source/host/automations/automation.ts"
import { diffAutomationAction, snapshotAutomations } from "../../source/host/transcript/automation-snapshot.ts"

function record(overrides: Partial<AutomationRecord> = {}): AutomationRecord {
  return {
    id: "automation-1",
    name: "Morning check",
    prompt: "Review the queue",
    trigger: { type: "cron", schedule: "0 9 * * *" },
    isEnabled: true,
    createdAt: 100,
    lastRunAt: null,
    raisedNotices: [],
    schedule: "0 9 * * *",
    triggerDescription: "Every morning",
    nextRunAt: null,
    runs: [{ id: "run-1", trigger: "manual", startedAt: 120, finishedAt: 130, status: "ok" }],
    filePath: "/repo/.slate/automations/morning.md",
    ...overrides,
  }
}

function snapshot(value: AutomationRecord) {
  return snapshotAutomations([value]).get(value.id)!
}

test("snapshots keep transcript and lifecycle fields while counting the runs recorded", () => {
  const result = snapshotAutomations([
    record(),
    record({ id: "automation-2", name: "Evening check", runs: [] }),
  ])

  assert.deepEqual([...result.keys()], ["automation-1", "automation-2"])
  assert.deepEqual(result.get("automation-1"), {
    id: "automation-1",
    name: "Morning check",
    prompt: "Review the queue",
    trigger: "cron:0 9 * * *",
    triggerType: "cron",
    schedule: "0 9 * * *",
    isEnabled: true,
    createdAt: 100,
    recordedRunCount: 1,
  })
  assert.equal(result.get("automation-2")?.recordedRunCount, 0)
})

test("when duplicate ids arrive, the last snapshot replaces the value without moving its key", () => {
  const result = snapshotAutomations([
    record(),
    record({ id: "automation-2" }),
    record({ name: "Updated name" }),
  ])

  assert.deepEqual([...result.keys()], ["automation-1", "automation-2"])
  assert.equal(result.get("automation-1")?.name, "Updated name")
})

test("name, prompt and trigger changes count as updates before enablement changes", () => {
  const before = snapshot(record())

  assert.equal(diffAutomationAction(before, snapshot(record({ name: "Renamed" }))), "updated")
  assert.equal(diffAutomationAction(before, snapshot(record({ prompt: "Different work" }))), "updated")
  assert.equal(diffAutomationAction(before, snapshot(record({ trigger: { type: "cron", schedule: "0 10 * * *" } }))), "updated")
  assert.equal(diffAutomationAction(before, snapshot(record({ name: "Renamed", isEnabled: false }))), "updated")
})

test("an enablement change is reported on its own, while metadata-only changes are ignored", () => {
  const before = snapshot(record())

  assert.equal(diffAutomationAction(before, snapshot(record({ isEnabled: false }))), "disabled")
  assert.equal(diffAutomationAction(snapshot(record({ isEnabled: false })), before), "enabled")
  assert.equal(diffAutomationAction(before, snapshot(record({ schedule: "0 10 * * *", createdAt: 200, runs: [] }))), null)
  assert.equal(diffAutomationAction(before, snapshot(record())), null)
})
