import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { BlobNotFoundError } from "../../source/packages/agent-kv/blob-not-found-error.ts"
import { toHex } from "../../source/packages/agent-kv/serde.ts"
import { createContext } from "../../source/packages/context/context.ts"
import { loggerKey, type ContextLogEntry } from "../../source/packages/context/logging.ts"
import { resolveSubagentPersistedStates } from "../../source/packages/agent-kv/subagent-states.ts"

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as { value: string }

describe("persisted subagent states", () => {
  it("uses a resolved blob when both blob and inline state exist", async () => {
    const result = await resolveSubagentPersistedStates(
      createContext(),
      {
        subagentStates: { child: { value: "inline" } },
        subagentStateRefs: { child: new Uint8Array([1]) },
      },
      { getBlob: async () => encode({ value: "blob" }) },
      decode,
    )

    assert.deepEqual(result, { child: { value: "blob" } })
  })

  it("falls back to inline state and warns when only its blob is missing", async () => {
    const entries: ContextLogEntry[] = []
    const context = createContext().with(loggerKey, {
      log: (_context, entry) => { entries.push(entry) },
    })
    const result = await resolveSubagentPersistedStates(
      context,
      {
        subagentStates: { child: { value: "inline" } },
        subagentStateRefs: { child: new Uint8Array([2]) },
      },
      { getBlob: async () => undefined },
      decode,
    )

    assert.deepEqual(result, { child: { value: "inline" } })
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.level, "warn")
    assert.equal(entries[0]?.message, "Subagent state ref blob not found; falling back to inline entry")
    assert.deepEqual(entries[0]?.metadata, { subagentId: "child" })
  })

  it("reports every missing blob when no inline copy can recover the conversation", async () => {
    const firstId = new Uint8Array([0x0a, 0x01])
    const secondId = new Uint8Array([0x0b, 0x02])

    await assert.rejects(
      resolveSubagentPersistedStates(
        createContext(),
        { subagentStates: {}, subagentStateRefs: { first: firstId, second: secondId } },
        { getBlob: async () => undefined },
        decode,
      ),
      (error: unknown) => {
        assert.ok(error instanceof BlobNotFoundError)
        assert.deepEqual(error.blobIdHexes, [toHex(firstId), toHex(secondId)])
        return true
      },
    )
  })

  it("does not mask a corrupt present blob with a valid inline copy", async () => {
    await assert.rejects(
      resolveSubagentPersistedStates(
        createContext(),
        {
          subagentStates: { child: { value: "inline" } },
          subagentStateRefs: { child: new Uint8Array([3]) },
        },
        { getBlob: async () => new Uint8Array([0xff]) },
        () => { throw new Error("corrupt state") },
      ),
      /corrupt state/,
    )
  })

  it("fetches no more than eight blobs at once and keeps the input order", async () => {
    const entries = Array.from({ length: 17 }, (_, index) => [
      `child-${String(index).padStart(2, "0")}`,
      new Uint8Array([index + 1]),
    ] as const)
    const refs = Object.fromEntries(entries)
    let active = 0
    let maximumActive = 0
    const release = Promise.withResolvers<void>()
    const pending = resolveSubagentPersistedStates(
      createContext(),
      { subagentStates: {}, subagentStateRefs: refs },
      {
        async getBlob(_context, blobId) {
          active += 1
          maximumActive = Math.max(maximumActive, active)
          await release.promise
          active -= 1
          return new Uint8Array(blobId)
        },
      },
      bytes => bytes[0] as number,
    )

    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(active, 8)
    release.resolve()
    const result = await pending

    assert.equal(maximumActive, 8)
    assert.deepEqual(Object.keys(result), entries.map(([id]) => id))
    assert.deepEqual(Object.values(result), entries.map(([, id]) => id[0]))
  })
})
