import assert from "node:assert/strict"
import test from "node:test"
import { SelectedDocumentation } from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import { createContext } from "../../source/packages/context/context.ts"
import { hydrateSelectedDocumentation } from "../../source/adapters/interop/agent/selected-documentation-hydration-adapter.ts"

test("selected documents are projected into Slate references before hydration", async () => {
  const context = createContext()
  let received: unknown
  const result = await hydrateSelectedDocumentation({
    ctx: context,
    documentations: [
      new SelectedDocumentation({ docId: "doc-1", name: "Guide" }),
      new SelectedDocumentation({ docId: "doc-2", name: "API" }),
    ],
    documentationHydrationService: {
      async hydrateDocumentation(ctx, documents, conversationQuery) {
        received = { ctx, documents, conversationQuery }
        return { chunks: ["guide", "api"] }
      },
    },
    conversationQuery: "How do these APIs fit together?",
  })

  assert.deepEqual(received, {
    ctx: context,
    documents: [{ id: "doc-1", displayName: "Guide" }, { id: "doc-2", displayName: "API" }],
    conversationQuery: "How do these APIs fit together?",
  })
  assert.deepEqual(result, { chunks: ["guide", "api"] })
})

test("no attachments skip the hydration service, while its failure propagates", async () => {
  let calls = 0
  const service = {
    async hydrateDocumentation() {
      calls += 1
      throw new Error("document service unavailable")
    },
  }
  const input = {
    ctx: createContext(),
    documentations: [],
    documentationHydrationService: service,
    conversationQuery: "query",
  }

  assert.equal(await hydrateSelectedDocumentation(input), undefined)
  assert.equal(calls, 0)
  await assert.rejects(hydrateSelectedDocumentation({
    ...input,
    documentations: [new SelectedDocumentation({ docId: "doc-1", name: "Guide" })],
  }), /document service unavailable/)
  assert.equal(calls, 1)
})
