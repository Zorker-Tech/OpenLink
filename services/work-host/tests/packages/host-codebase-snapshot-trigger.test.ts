import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  CodebaseSnapshotTrigger,
  MAX_HANDLED_REASONS,
  type SnapshotReason,
} from "../../source/host/extensions/codebase-telemetry/codebase-snapshot-trigger.ts"

const reason = (requestId: string): SnapshotReason => ({ type: "AGENT_REQUEST_START", requestId })
const tick = () => new Promise((resolve) => setImmediate(resolve))

describe("codebase snapshot trigger", () => {
  it("forgets the oldest key at capacity and continues deduplicating newer reasons", () => {
    let calls = 0
    const trigger = new CodebaseSnapshotTrigger({
      getSession: () => ({ snapshot: async () => { calls += 1 } }),
      logger: { debug: () => {}, warn: () => {} },
    })

    for (let index = 0; index <= MAX_HANDLED_REASONS; index += 1) {
      trigger.handle(reason(`request-${index}`))
    }
    assert.equal(calls, MAX_HANDLED_REASONS + 1)

    trigger.handle(reason("request-0"))
    trigger.handle(reason("request-0"))
    assert.equal(calls, MAX_HANDLED_REASONS + 2)
  })

  it("treats a synchronous snapshot throw as a failed attempt that can be retried", async () => {
    let attempts = 0
    const warnings: string[] = []
    const trigger = new CodebaseSnapshotTrigger({
      getSession: () => ({
        snapshot: () => {
          attempts += 1
          if (attempts === 1) throw new Error("sync failure")
          return Promise.resolve()
        },
      }),
      logger: { debug: () => {}, warn: (message) => { warnings.push(message) } },
    })

    trigger.handle(reason("retry-me"))
    await tick()
    trigger.handle(reason("retry-me"))
    await tick()

    assert.equal(attempts, 2)
    assert.deepEqual(warnings, ["snapshot trigger failed (failure #1)"])
  })
})
