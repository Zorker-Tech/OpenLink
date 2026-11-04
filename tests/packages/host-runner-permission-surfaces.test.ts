import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  HostRunnerPermissionSurfaces,
  type LocalToolPermissionEvent,
} from "../../source/host/runner/host-runner-permission-surfaces.ts"

interface Subscription {
  active: boolean
  listener: (event: LocalToolPermissionEvent) => void
}

function harness() {
  const subscriptions: Subscription[] = []
  const manager = new HostRunnerPermissionSurfaces((listener) => {
    const subscription = { active: true, listener }
    subscriptions.push(subscription)
    return () => { subscription.active = false }
  }, () => 1234)
  return { manager, subscriptions }
}

describe("host runner local tool permission surfaces", () => {
  it("replaces a session's prior subscription and only publishes matching agent events", () => {
    const { manager, subscriptions } = harness()
    const firstUpdates: unknown[] = []
    const secondUpdates: unknown[] = []
    manager.bind("agent-1", false, { onUpdate: (update) => firstUpdates.push(update) })
    const first = subscriptions[0]
    manager.bind("agent-1", false, { onUpdate: (update) => secondUpdates.push(update) })
    const second = subscriptions[1]

    assert.equal(first?.active, false)
    assert.equal(second?.active, true)
    assert.equal(manager.canAsk("agent-1"), true)
    if (first?.active) first.listener({ type: "created", request: { agentId: "agent-1", id: "old" } })
    second?.listener({ type: "created", request: { agentId: "agent-2", id: "other" } })
    second?.listener({
      type: "created",
      request: { agentId: "agent-1", id: "permission-1", action: "write", target: "/workspace/a", description: "Needs approval" },
    })

    assert.deepEqual(firstUpdates, [])
    assert.deepEqual(secondUpdates, [{
      type: "send-message",
      message: {
        type: "local-tool-permission",
        ask: {
          requestId: "permission-1",
          action: "write",
          target: "/workspace/a",
          status: "pending",
          description: "Needs approval",
        },
      },
      timestampMs: 1234,
    }])
  })

  it("unsubscribes before declining a group-member turn", () => {
    const { manager, subscriptions } = harness()
    manager.bind("agent-1", false, { onUpdate: () => {} })
    manager.bind("agent-1", true, { onUpdate: () => {} })

    assert.equal(subscriptions[0]?.active, false)
    assert.equal(subscriptions.length, 1)
    assert.equal(manager.canAsk("agent-1"), false)
  })

  it("maps pending status to expired and passes other status values through", () => {
    const { manager, subscriptions } = harness()
    const updates: unknown[] = []
    manager.bind("agent-1", false, { onUpdate: (update) => updates.push(update) })
    const subscription = subscriptions[0]
    subscription?.listener({ type: "status", request: { agentId: "agent-1", id: "p-1", status: "pending" } })
    subscription?.listener({ type: "status", request: { agentId: "agent-1", id: "p-2", status: "approved" } })

    assert.deepEqual(updates, [
      { type: "local-tool-permission-status", requestId: "p-1", status: "expired" },
      { type: "local-tool-permission-status", requestId: "p-2", status: "approved" },
    ])
  })

  it("forgets one agent independently and disposes every remaining subscription", () => {
    const { manager, subscriptions } = harness()
    manager.bind("agent-1", false, { onUpdate: () => {} })
    manager.bind("agent-2", false, { onUpdate: () => {} })
    manager.forget("agent-1")

    assert.equal(subscriptions[0]?.active, false)
    assert.equal(subscriptions[1]?.active, true)
    assert.equal(manager.canAsk("agent-1"), false)
    assert.equal(manager.canAsk("agent-2"), true)

    manager.dispose()
    assert.equal(subscriptions[1]?.active, false)
    assert.equal(manager.canAsk("agent-2"), false)
  })
})
