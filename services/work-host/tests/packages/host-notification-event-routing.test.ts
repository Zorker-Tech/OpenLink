import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { NotificationAgent } from "../../source/shared/os-notification.ts"
import {
  dispatchNotificationHostEvent,
  type NotificationEventTarget,
  type NotificationHostEvent,
} from "../../source/host/notifications/event-routing.ts"

describe("notification host event routing", () => {
  it("forwards each owned event to the matching notifier operation with its presence", () => {
    const calls: unknown[][] = []
    const notifier: NotificationEventTarget = {
      seedBaseline: agents => { calls.push(["baseline", agents]) },
      handleAgentsEvent: (event, presence) => { calls.push(["agents", event, presence]) },
      handleAgentUpsertedEvent: (event, presence) => { calls.push(["upsert", event, presence]) },
      forget: agentId => { calls.push(["forget", agentId]) },
    }
    const agents = [{ id: "agent-1" }] as unknown as readonly NotificationAgent[]
    const snapshotEvent = { agents }
    const presence = { windowFocusedAtMs: 1_000 }
    const events: readonly NotificationHostEvent[] = [
      { kind: "notification-baseline", agents },
      { kind: "notification-agents", event: snapshotEvent, presence },
      { kind: "notification-agent-upserted", event: { agent: agents[0]! }, presence },
      { kind: "notification-agent-forgotten", agentId: "agent-1" },
    ]

    for (const event of events) dispatchNotificationHostEvent(notifier, event)

    assert.deepEqual(calls, [
      ["baseline", agents],
      ["agents", snapshotEvent, presence],
      ["upsert", { agent: agents[0] }, presence],
      ["forget", "agent-1"],
    ])
  })
})
