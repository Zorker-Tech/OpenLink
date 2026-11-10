import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createPromptCollectorGlue } from "../../source/host/runner/prompt-collector-glue.ts"
import type { AutomationRecord } from "../../source/host/automations/automation.ts"
import type {
  AutomationStatusSource,
  AutomationTimeZoneResolver,
} from "../../source/host/automations/automation-status-reminder.ts"

function routine(id: string): AutomationRecord {
  return {
    id,
    name: `Routine ${id}`,
    prompt: "run",
    trigger: {},
    isEnabled: false,
    createdAt: 0,
    lastRunAt: null,
    raisedNotices: [],
    schedule: "",
    triggerDescription: "",
    nextRunAt: null,
    runs: [],
    filePath: `/automations/${id}`,
  } as never
}

describe("automation status prompt source", () => {
  it("uses the host fallback when the local store has no location and never reads that store", () => {
    let reads = 0
    const store: AutomationStatusSource = {
      getLocation: () => null,
      list: () => { reads += 1; return [routine("unexpected")] },
    }
    const glue = createPromptCollectorGlue({
      automationStore: store,
      requestContext: { resolve: () => ({ timeZone: "UTC" }) },
      getAutomationStatusReminder: () => "host fallback",
    } as never)

    assert.equal(glue.getAutomationStatusReminderForTurn(1), "host fallback")
    assert.equal(reads, 0)
  })

  it("prefers current definitions to runtime records and resolves the time zone for rendering", () => {
    const store: AutomationStatusSource = {
      getLocation: () => "/automations",
      list: () => [routine("runtime-list")],
      listDefinitions: () => [routine("definitions")],
    }
    let resolves = 0
    const timeZone: AutomationTimeZoneResolver = {
      resolve: () => { resolves += 1; return { timeZone: "UTC" } },
    }
    const glue = createPromptCollectorGlue({ automationStore: store, requestContext: timeZone } as never)
    const reminder = glue.getAutomationStatusReminderForTurn(1) ?? ""

    assert.match(reminder, /Routine definitions/)
    assert.doesNotMatch(reminder, /runtime-list/)
    assert.equal(resolves, 1)
  })

  it("uses the host fallback when no time-zone resolver is available", () => {
    const store: AutomationStatusSource = {
      getLocation: () => "/automations",
      list: () => [routine("runtime-list")],
    }
    const glue = createPromptCollectorGlue({
      automationStore: store,
      requestContext: undefined,
      getAutomationStatusReminder: () => "host fallback",
    } as never)

    assert.equal(glue.getAutomationStatusReminderForTurn(1), "host fallback")
  })
})
