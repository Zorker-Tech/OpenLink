import { test } from "node:test"
import assert from "node:assert/strict"

import {
  type WebSearchServiceRequest,
  type WebSearchServiceResult,
} from "../../source/packages/agent/tools/core/web-search.ts"
import { createWebSearchTool } from "../../source/adapters/interop/agent/web-search-tool-adapter.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { ToolCallRejectedError } from "../../source/packages/agent/tools/tool-errors.ts"
import { Responses, type SlateInteractionQuery } from "../../source/packages/agent-core/interaction-queries.ts"
import { WebSearchResult } from "../../source/adapters/interop/proto/generated/agent/v1/web_search_tool_pb.ts"
import { AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES } from "../../source/adapters/interop/agent/agent-tools-file-adapter.ts"
import { buildWebSearchYearGuidance } from "../../source/packages/utils/search-year-guidance.ts"

// ---------------------------------------------------------------------------------------------
// the tool over a scripted search service
// ---------------------------------------------------------------------------------------------

interface Harness {
  readonly asked: WebSearchServiceRequest[]
  readonly writes: Array<{ path: string; text: string; maxSize?: number }>
  readonly queries: string[]
  readonly tool: Record<string, unknown>
}

function harness(options: {
  result?: WebSearchServiceResult
  throwResult?: () => never
  rejectQuery?: string
  projectFolder?: string
  promptVersion?: string
  minimal?: boolean
  conversationStartedDate?: string
  failWrite?: boolean
  withResourceAccessor?: boolean
} = {}): Harness {
  const asked: WebSearchServiceRequest[] = []
  const writes: Harness["writes"] = []
  const queries: string[] = []
  const resourceAccessor = {
    get: () => ({
      async execute(_ctx: Context, args: { path: string; text?: string; bytes?: Uint8Array; maxSize?: number }) {
        if (options.failWrite === true) return { kind: "error", path: args.path, error: "no" }
        writes.push({
          path: args.path,
          text: args.text ?? new TextDecoder().decode(args.bytes ?? new Uint8Array()),
        })
        return { kind: "success", path: args.path, linesWritten: args.text?.split("\n").length ?? 0, bytesWritten: args.bytes?.length ?? 0 }
      },
    }),
  }
  return {
    asked,
    writes,
    queries,
    tool: createWebSearchTool({
      async webSearchService(_ctx, args) {
        asked.push(args)
        if (options.throwResult !== undefined) options.throwResult()
        return options.result ?? { documents: [] }
      },
      ...(options.promptVersion === undefined ? {} : { promptVersion: options.promptVersion }),
      ...(options.minimal === undefined ? {} : { useMinimalHarness: options.minimal }),
      ...(options.conversationStartedDate === undefined ? {} : { conversationStartedDate: options.conversationStartedDate }),
      ...(options.projectFolder === undefined ? {} : { projectFolder: options.projectFolder }),
      ...(options.withResourceAccessor === false ? {} : { resourceAccessor: resourceAccessor as never }),
    }) as never,
  }
}

interface ToolLike {
  name: string
  descriptionGenerator(): string
  parameters: { jsonSchema?: { properties?: Record<string, unknown> } }
  execute(ctx: Context, handler: unknown, argsStream: AsyncIterable<string>, meta: Record<string, unknown>): Promise<WebSearchResult>
  render(ctx: Context, result: WebSearchResult): Promise<{ content: Array<{ text?: string }> }>
  serializeError(error: unknown): unknown
}

const asTool = (tool: Record<string, unknown>): ToolLike => tool as unknown as ToolLike

async function* argsOf(args: unknown): AsyncIterable<string> {
  yield JSON.stringify(args)
}

function handler(harnessed: Harness, options: { rejectQuery?: string } = {}): unknown {
  return {
    listener: {
      async query(_ctx: Context, query: SlateInteractionQuery) {
        harnessed.queries.push(query.kind)
        return options.rejectQuery === undefined
          ? Responses.webSearchApproved(query.id)
          : Responses.webSearchRejected(query.id, options.rejectQuery)
      },
    },
    emitPartialToolCall() {},
    async executeToolCall(ctx: Context, _call: unknown, _id: string, run: (ctx: Context) => Promise<WebSearchResult>, merge: (result: WebSearchResult) => unknown) {
      const result = await run(ctx)
      merge(result)
      return result
    },
  }
}

const run = (harnessed: Harness, args: unknown, options: { rejectQuery?: string } = {}) =>
  asTool(harnessed.tool).execute(createContext(), handler(harnessed, options), argsOf(args), { toolCallId: "call-1" })

const textOf = (result: { content: Array<{ text?: string }> }): string => result.content.map(part => part.text ?? "").join("")

const referencesOf = (result: WebSearchResult): Array<{ title: string; url: string; chunk: string }> =>
  result.result.case === "success" ? result.result.value.references : []

// ---------------------------------------------------------------------------------------------
// what the model is told about the tool
// ---------------------------------------------------------------------------------------------

test("the tool is named the way each prompt version expects", () => {
  assert.equal(asTool(harness({ promptVersion: "dsv3-1018" }).tool).name, "web_search")
  for (const version of ["cursor-0226", "dsv3-1205", "latest", "gpt5-codex", "codex-cloud", "haiku"]) {
    assert.equal(asTool(harness({ promptVersion: version }).tool).name, "WebSearch", version)
  }
  assert.throws(() => harness({ promptVersion: "future-model" }), /Unhandled version: future-model/)
})

test("the newest versions are told what year it is, and refuse to guess it", () => {
  const withoutDate = harness({ promptVersion: "latest" })
  assert.throws(() => asTool(withoutDate.tool).descriptionGenerator(), /conversationStartedDate is required for WebSearch prompts with year guidance/)

  const dated = harness({ promptVersion: "latest", conversationStartedDate: "2026-09-25" })
  assert.match(asTool(dated.tool).descriptionGenerator(), /Search the web for real-time information about any topic\./)
})

test("the older versions carry their own wording, and the minimal harness one line", () => {
  const codex = asTool(harness({ promptVersion: "gpt5-codex" }).tool).descriptionGenerator()
  assert.match(codex, /^Search web for real-time info on any topic/)
  const older = asTool(harness({ promptVersion: "dsv3-1018" }).tool).descriptionGenerator()
  assert.match(older, /^Search the web for real-time information about any topic\./)
  const minimal = asTool(harness({ promptVersion: "latest", minimal: true }).tool).descriptionGenerator()
  assert.match(minimal, /^Search the web for up-to-date information and return snippets and URLs\./)
})

test("the year guidance the newest description carries is the one built from the date", () => {
  assert.equal(typeof buildWebSearchYearGuidance("2026-09-25"), "string")
})

test("the arguments are a search term and an explanation", () => {
  const tool = asTool(harness({ promptVersion: "latest", conversationStartedDate: "2026-09-25" }).tool)
  assert.deepEqual(Object.keys(tool.parameters.jsonSchema?.properties ?? {}), ["search_term", "explanation"])
})

// ---------------------------------------------------------------------------------------------
// the search itself
// ---------------------------------------------------------------------------------------------

test("the search is asked of the user and then of the provider", async () => {
  const harnessed = harness({ result: { documents: [{ title: "A page", url: "https://example.test", text: "the text" }] } })
  const result = await run(harnessed, { search_term: "how to do a thing" })
  assert.deepEqual(harnessed.queries, ["web-search"])
  assert.deepEqual(harnessed.asked, [{ searchTerm: "how to do a thing" }])
  assert.equal(referencesOf(result).length, 1)
  assert.equal(referencesOf(result)[0]?.title, "A page")
  assert.equal(referencesOf(result)[0]?.url, "https://example.test")
  assert.equal(referencesOf(result)[0]?.chunk, "the text")
})

test("an explanation is passed on when it is given", async () => {
  const harnessed = harness()
  await run(harnessed, { search_term: "a thing", explanation: "because the user asked" })
  assert.deepEqual(harnessed.asked, [{ searchTerm: "a thing", explanation: "because the user asked" }])
})

test("a search the user refuses is reported as a refusal", async () => {
  const harnessed = harness()
  await assert.rejects(() => run(harnessed, { search_term: "a thing" }, { rejectQuery: "not now" }), ToolCallRejectedError)
  assert.deepEqual(harnessed.asked, [])
})

test("the older argument names are read as the search term", async () => {
  const harnessed = harness()
  await run(harnessed, { query: "a thing" })
  assert.deepEqual(harnessed.asked, [{ searchTerm: "a thing" }])

  const camel = harness()
  await run(camel, { searchTerm: "another thing" })
  assert.deepEqual(camel.asked, [{ searchTerm: "another thing" }])
})

test("an answer from the provider comes first, as its own reference", async () => {
  const harnessed = harness({
    result: { answer: "the answer", documents: [{ title: "A page", url: "https://example.test", text: "the text" }] },
  })
  const result = await run(harnessed, { search_term: "a thing" })
  assert.equal(referencesOf(result)[0]?.title, "Web search results")
  assert.equal(referencesOf(result)[0]?.chunk, "the answer")
  assert.equal(referencesOf(result)[0]?.url, "")
})

test("with an answer in hand the documents are the detail rather than the content", async () => {
  const harnessed = harness({
    result: { answer: "the answer", documents: [{ title: "A page", url: "https://example.test", text: "x".repeat(100_000) }] },
  })
  const result = await run(harnessed, { search_term: "a thing" })
  // The document is neither written out nor pasted: the answer already says what was found.
  assert.deepEqual(harnessed.writes, [])
  assert.equal(referencesOf(result).length, 1)
})

test("a long document is written out and the reference says where to read it", async () => {
  const long = "x".repeat(AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES + 1)
  const harnessed = harness({ projectFolder: "/repo", result: { documents: [{ title: "A page", url: "https://example.test", text: long }] } })
  const result = await run(harnessed, { search_term: "a thing" })
  assert.equal(harnessed.writes.length, 1)
  assert.equal(harnessed.writes[0]?.text, long)
  assert.match(referencesOf(result)[0]?.chunk ?? "", /^Full page text written to file: /)
  assert.match(referencesOf(result)[0]?.chunk ?? "", /no follow-up fetch is needed/)
})

test("a session with nowhere to write keeps the first part of the document", async () => {
  const long = "x".repeat(100_000)
  const harnessed = harness({ result: { documents: [{ title: "A page", url: "https://example.test", text: long }] } })
  const result = await run(harnessed, { search_term: "a thing" })
  assert.deepEqual(harnessed.writes, [])
  assert.equal(referencesOf(result)[0]?.chunk.length, 30_000)
})

test("a write that fails falls back to the first part of the document", async () => {
  // Longer than the inline cap as well as the file threshold, so the fallback has something to cut.
  const long = "x".repeat(40_000)
  const harnessed = harness({ projectFolder: "/repo", failWrite: true, result: { documents: [{ title: "A page", url: "https://example.test", text: long }] } })
  const result = await run(harnessed, { search_term: "a thing" })
  assert.equal(referencesOf(result)[0]?.chunk.length, 30_000)
})

test("a document that fits the inline cap is kept whole when it cannot be written out", async () => {
  const medium = "x".repeat(AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES + 1)
  const harnessed = harness({ projectFolder: "/repo", failWrite: true, result: { documents: [{ title: "A page", url: "https://example.test", text: medium }] } })
  const result = await run(harnessed, { search_term: "a thing" })
  assert.equal(referencesOf(result)[0]?.chunk, medium)
})


test("an empty answer is not a reference at all", async () => {
  const harnessed = harness({ result: { answer: "", documents: [{ title: "A page", url: "https://example.test", text: "the text" }] } })
  const references = referencesOf(await run(harnessed, { search_term: "anything" }))
  assert.equal(references.length, 1)
  assert.equal(references[0]?.chunk, "the text")
})

test("a provider that answered with nothing yields no references", async () => {
  const harnessed = harness({ result: { documents: [] } })
  const result = await run(harnessed, { search_term: "a thing" })
  assert.deepEqual(referencesOf(result), [])
})

// ---------------------------------------------------------------------------------------------
// what the model is shown
// ---------------------------------------------------------------------------------------------

test("references are shown with their titles, URLs and content", async () => {
  const harnessed = harness({ result: { documents: [{ title: "A page", url: "https://example.test", text: "the text" }] } })
  const result = await run(harnessed, { search_term: "a thing" })
  const rendered = textOf(await asTool(harnessed.tool).render(createContext(), result))
  assert.match(rendered, /^Title: A page\nURL: https:\/\/example\.test\nContent: the text\n---\n/)
})

test("a reference with no URL is shown without one", async () => {
  const harnessed = harness({ result: { answer: "the answer", documents: [] } })
  const result = await run(harnessed, { search_term: "a thing" })
  assert.match(textOf(await asTool(harnessed.tool).render(createContext(), result)), /^Title: Web search results\nContent: the answer/)
})

test("an error and a refusal are shown as themselves", async () => {
  const harnessed = harness()
  const errored = new WebSearchResult({ result: { case: "error", value: { error: "the provider said no" } as never } })
  assert.equal(textOf(await asTool(harnessed.tool).render(createContext(), errored)), "Error: the provider said no")

  const rejected = new WebSearchResult({ result: { case: "rejected", value: { reason: "" } as never } })
  assert.equal(textOf(await asTool(harnessed.tool).render(createContext(), rejected)), "The web search was rejected by the user.")

  const withReason = new WebSearchResult({ result: { case: "rejected", value: { reason: "not now" } as never } })
  assert.equal(textOf(await asTool(harnessed.tool).render(createContext(), withReason)), "Web search rejected: not now")
})

test("an error is serialized into the call the turn records", () => {
  const harnessed = harness()
  const serialized = asTool(harnessed.tool).serializeError(new ToolCallRejectedError("not now")) as { tool?: { value?: { result?: WebSearchResult } } }
  assert.equal(serialized.tool?.value?.result?.result.case, "rejected")

  const errored = asTool(harnessed.tool).serializeError(new Error("boom")) as { tool?: { value?: { result?: WebSearchResult } } }
  assert.equal(errored.tool?.value?.result?.result.case, "error")
})

test("a provider failure that says it is temporary is classified as one worth retrying", async () => {
  const harnessed = harness({ throwResult: () => { throw new Error("API request failed: 429") } })
  await assert.rejects(
    () => run(harnessed, { search_term: "a thing" }),
    (error: Error) => {
      // The status is carried on the error so a retry can be explained, and the failure is classified as a
      // provider error rather than as a mistake in the request.
      assert.equal((error as { classification?: string }).classification, "provider_error")
      // The status is carried in the error's own text, and what the model is told says it may pass.
      assert.match(error.message, /provider_status=429/)
      assert.match(String((error as { clientVisibleErrorMessage?: string }).clientVisibleErrorMessage), /may be temporary/)
      return true
    },
  )
})

test("a provider failure wrapped around its cause is still read for the status", async () => {
  const inner = new Error("API request failed: 503")
  const harnessed = harness({ throwResult: () => { throw new Error("the client failed", { cause: inner }) } })
  await assert.rejects(
    () => run(harnessed, { search_term: "a thing" }),
    (error: Error) => /provider_status=503/.test(error.message),
  )
})

test("a provider failure that says nothing about retrying is passed on as it came", async () => {
  const harnessed = harness({ throwResult: () => { throw new Error("API request failed: 400") } })
  await assert.rejects(
    () => run(harnessed, { search_term: "a thing" }),
    (error: Error) => error.constructor === Error && error.message === "API request failed: 400",
  )
})

test("a 500 from the provider is worth trying again, like the other server errors", async () => {
  const harnessed = harness({ throwResult: () => { throw new Error("API request failed: 500") } })
  await assert.rejects(run(harnessed, { search_term: "anything" }), (error: Error) => /provider_status=500/.test(error.message))
})
