import assert from "node:assert/strict"
import { test } from "node:test"

import {
  backendCloudTrigger,
  linearCloudTrigger,
  microsoftTeamsCloudTrigger,
  pagerDutyCloudTrigger,
  sentryCloudTrigger,
} from "../../source/adapters/interop/cursor-backend/slate-automation-cloud-trigger-adapter.ts"
import type { LinearTrigger, MicrosoftTeamsTrigger, PagerDutyTrigger, SentryTrigger } from "../../source/shared/automations.ts"

function teamsOf(trigger: ReturnType<typeof microsoftTeamsCloudTrigger>) {
  return trigger.trigger.value as {
    tenantId: string
    teamId: string
    teamIds: string[]
    channelIds: string[]
    messageContains: string
    messageContainsIsRegex: boolean
    blockUnauthenticatedTeamsUsers: boolean
  }
}

test("the team-message mapping carries every filter field and snapshots the repeated ids", () => {
  const teamIds = ["team-1"]
  const channelIds = ["channel-1"]
  const input: MicrosoftTeamsTrigger = {
    type: "microsoftTeams",
    tenantId: "tenant-1",
    teamId: "team-main",
    teamIds,
    channelIds,
    messageContains: "deploy",
    messageContainsIsRegex: true,
    blockUnauthenticatedTeamsUsers: false,
  }

  const converted = microsoftTeamsCloudTrigger(input)
  teamIds.push("later-team")
  channelIds.push("later-channel")
  assert.equal(converted.trigger.case, "microsoftTeamsTrigger")
  const mapped = teamsOf(converted)
  assert.deepEqual([mapped.tenantId, mapped.teamId], ["tenant-1", "team-main"])
  assert.deepEqual(mapped.teamIds, ["team-1"])
  assert.deepEqual(mapped.channelIds, ["channel-1"])
  assert.deepEqual([mapped.messageContains, mapped.messageContainsIsRegex, mapped.blockUnauthenticatedTeamsUsers], ["deploy", true, false])
})

test("linear event cases preserve their selected ids and leave unknown variants unset", () => {
  const created = linearCloudTrigger({ type: "linear", event: { case: "issueCreated" }, projectIds: ["project-1"], teamIds: ["team-1"] })
  const createdValue = created.trigger.value as { event: { case?: string }; projectIds: string[]; teamIds: string[] }
  assert.deepEqual([created.trigger.case, createdValue.event.case, createdValue.projectIds, createdValue.teamIds], ["linear", "issueCreated", ["project-1"], ["team-1"]])

  const statusIds = ["status-1"]
  const status = linearCloudTrigger({ type: "linear", event: { case: "statusChanged", statusIds }, projectIds: [], teamIds: [] })
  statusIds.push("later-status")
  const statusValue = status.trigger.value as { event: { case?: string; value?: { statusIds: string[] } } }
  assert.equal(statusValue.event.case, "statusChanged")
  assert.deepEqual(statusValue.event.value?.statusIds, ["status-1"])

  const cycleIds = ["cycle-1"]
  const cycle = linearCloudTrigger({ type: "linear", event: { case: "endOfCycle", cycleIds }, projectIds: [], teamIds: [] })
  cycleIds.push("later-cycle")
  const cycleValue = cycle.trigger.value as { event: { case?: string; value?: { cycleIds: string[] } } }
  assert.equal(cycleValue.event.case, "endOfCycle")
  assert.deepEqual(cycleValue.event.value?.cycleIds, ["cycle-1"])

  const unknown = linearCloudTrigger({ type: "linear", event: { case: "future-event" } as never, projectIds: [], teamIds: [] })
  assert.equal((unknown.trigger.value as { event: { case?: string } }).event.case, undefined)
})

test("sentry and incident events map only recognized cases and copy their selectors", () => {
  const sentryCases = ["issueCreated", "issueResolved", "issueAssigned", "issueArchived", "issueUnresolved", "issueAny"]
  for (const eventCase of sentryCases) {
    const converted = sentryCloudTrigger({ type: "sentry", event: { case: eventCase }, projectIds: ["project-1"] })
    const value = converted.trigger.value as { event: { case?: string }; projectIds: string[] }
    assert.equal(converted.trigger.case, "sentry")
    assert.equal(value.event.case, eventCase)
    assert.deepEqual(value.projectIds, ["project-1"])
  }
  const unknownSentry = sentryCloudTrigger({ type: "sentry", event: { case: "future-event" }, projectIds: [] } as unknown as SentryTrigger)
  assert.equal((unknownSentry.trigger.value as { event: { case?: string } }).event.case, undefined)

  const incidentCases = ["incidentTriggered", "incidentAcknowledged", "incidentResolved", "incidentEscalated", "incidentAny"]
  for (const eventCase of incidentCases) {
    const converted = pagerDutyCloudTrigger({ type: "pagerduty", event: { case: eventCase }, serviceIds: ["service-1"] })
    const value = converted.trigger.value as { event: { case?: string }; serviceIds: string[] }
    assert.equal(converted.trigger.case, "pagerduty")
    assert.equal(value.event.case, eventCase)
    assert.deepEqual(value.serviceIds, ["service-1"])
  }
  const unknownIncident = pagerDutyCloudTrigger({ type: "pagerduty", event: { case: "future-event" }, serviceIds: [] } as unknown as PagerDutyTrigger)
  assert.equal((unknownIncident.trigger.value as { event: { case?: string } }).event.case, undefined)
})

test("the typed dispatcher selects the corresponding wire envelope", () => {
  const triggers = [
    backendCloudTrigger({ type: "microsoftTeams", tenantId: "t", teamId: "m", teamIds: [], channelIds: [], messageContains: "", messageContainsIsRegex: false, blockUnauthenticatedTeamsUsers: true }),
    backendCloudTrigger({ type: "linear", event: { case: "issueCreated" }, projectIds: [], teamIds: [] }),
    backendCloudTrigger({ type: "sentry", event: { case: "issueAny" }, projectIds: [] }),
    backendCloudTrigger({ type: "pagerduty", event: { case: "incidentAny" }, serviceIds: [] }),
  ]
  assert.deepEqual(triggers.map(trigger => trigger.trigger.case), ["microsoftTeamsTrigger", "linear", "sentry", "pagerduty"])
})
