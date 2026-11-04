import assert from "node:assert/strict"
import test from "node:test"

import {
  InvocationContext,
  InvocationContext_IdeState,
  InvocationContext_IdeState_File,
} from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import { createContext } from "../../source/packages/context/context.ts"
import { hydrateSelectedInvocationContext } from "../../source/adapters/interop/agent/selected-invocation-context-hydration-adapter.ts"

test("an inline invocation is preserved and an absent one stays absent", async () => {
  const invocationContext = new InvocationContext({
    data: {
      case: "ideState",
      value: new InvocationContext_IdeState({
        visibleFiles: [new InvocationContext_IdeState_File({ path: "/repo/entry.ts" })],
      }),
    },
  })

  assert.equal(await hydrateSelectedInvocationContext({
    ctx: createContext(),
    invocationContext,
  }), invocationContext)
  assert.equal(await hydrateSelectedInvocationContext({ ctx: createContext() }), undefined)
})

test("a blob reference is fetched and decoded as an invocation", async () => {
  const ctx = createContext()
  const blobId = new Uint8Array([4, 7, 2])
  const invocationContext = new InvocationContext({
    data: { case: "blobId", value: blobId },
  })
  const storedContext = new InvocationContext({
    data: {
      case: "ideState",
      value: new InvocationContext_IdeState({
        visibleFiles: [new InvocationContext_IdeState_File({ path: "/repo/stored.ts" })],
      }),
    },
  })

  let request: { ctx: unknown; blobId: Uint8Array } | undefined
  const hydrated = await hydrateSelectedInvocationContext({
    ctx,
    invocationContext,
    blobStore: {
      async getBlob(receivedContext, requestedId) {
        request = { ctx: receivedContext, blobId: requestedId }
        return storedContext.toBinary()
      },
    },
  })

  assert.deepEqual(request, { ctx, blobId })
  assert.ok(hydrated)
  assert.equal(InvocationContext.equals(hydrated, storedContext), true)
})

test("missing storage and missing blob data remain explicit errors", async () => {
  const invocationContext = new InvocationContext({
    data: { case: "blobId", value: new Uint8Array([1]) },
  })

  await assert.rejects(
    hydrateSelectedInvocationContext({ ctx: createContext(), invocationContext }),
    /Blob store is required to hydrate invocation context blob/,
  )
  await assert.rejects(
    hydrateSelectedInvocationContext({
      ctx: createContext(),
      invocationContext,
      blobStore: { async getBlob() { return undefined } },
    }),
    /Invocation context blob not found/,
  )
})
