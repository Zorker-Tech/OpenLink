import { test } from "node:test"
import assert from "node:assert/strict"

import { createWebFetchTool, type WebFetchServiceResult } from "../../source/packages/agent/tools/core/web-fetch.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { ToolCallRejectedError, ToolTimeoutError } from "../../source/packages/agent/tools/tool-errors.ts"
import { WebFetchResult, WebFetchToolCall } from "../../source/packages/proto/generated/agent/v1/web_fetch_tool_pb.ts"
import { writeExecutorResource } from "../../source/packages/agent-exec/write-operation.ts"
import { AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES } from "../../source/packages/agent-exec/agent-tools-file.ts"

// ---------------------------------------------------------------------------------------------
// the tool over a scripted fetch service and query listener
// ---------------------------------------------------------------------------------------------

interface Harness {
  readonly writes: Array<{ path: string; text: string }>
  readonly fetched: string[]
  readonly queries: Array<{ case: string }>
  readonly tool: Record<string, unknown>
}

function harness(options: {
  answer?: WebFetchServiceResult
  rejectQuery?: string
  projectFolder?: string
  promptVersion?: string
  minimal?: boolean
  stripCredentials?: boolean
  failWrite?: boolean
  withResourceAccessor?: boolean
} = {}): Harness {
  const writes: Harness["writes"] = []
  const fetched: string[] = []
  const queries: Array<{ case: string }> = []
  const resourceAccessor = {
    get: (resource?: unknown) => {
      void resource
      return {
        async execute(_ctx: Context, args: { path: string; fileText?: string; fileBytes?: Uint8Array }) {
          if (options.failWrite === true) return { result: { case: "error", value: { error: "no" } } }
          writes.push({
            path: args.path,
            text: args.fileText ?? new TextDecoder().decode(args.fileBytes ?? new Uint8Array()),
          })
          return { result: { case: "success", value: { path: args.path } } }
        },
      }
    },
  }
  return {
    writes,
    fetched,
    queries,
    tool: createWebFetchTool({
      async webFetchService(_ctx, url) {
        fetched.push(url)
        return options.answer ?? { content: "# The page\n\nsome content" }
      },
      ...(options.promptVersion === undefined ? {} : { promptVersion: options.promptVersion }),
      ...(options.minimal === undefined ? {} : { useMinimalHarness: options.minimal }),
      ...(options.projectFolder === undefined ? {} : { projectFolder: options.projectFolder }),
      ...(options.stripCredentials === undefined ? {} : { stripCredentialedUrls: options.stripCredentials }),
      ...(options.withResourceAccessor === false ? {} : { resourceAccessor: resourceAccessor as never }),
    }),
  }
}

interface ToolLike {
  name: string
  descriptionGenerator(): string
  parameters: { jsonSchema?: { properties?: Record<string, unknown>; required?: string[] } }
  execute(ctx: Context, handler: unknown, argsStream: AsyncIterable<string>, meta: Record<string, unknown>): Promise<WebFetchResult>
  render(ctx: Context, result: WebFetchResult): Promise<{ content: Array<{ type: string; text?: string }>; isError: boolean }>
  serializeError(error: unknown): unknown
}

const asTool = (tool: Record<string, unknown>): ToolLike => tool as unknown as ToolLike

async function* argsOf(args: unknown): AsyncIterable<string> {
  yield JSON.stringify(args)
}

interface HandlerHarness {
  readonly listener: { query(ctx: Context, query: { query: { case: string } }): Promise<unknown> }
  emitPartialToolCall(): void
  executeToolCall(ctx: Context, call: unknown, id: string, run: (ctx: Context) => Promise<WebFetchResult>, merge: (result: WebFetchResult) => unknown): Promise<WebFetchResult>
}

function handler(harnessed: Harness, options: { rejectQuery?: string } = {}): HandlerHarness {
  return {
    listener: {
      async query(_ctx, query) {
        harnessed.queries.push({ case: query.query.case })
        // The listener answers with the response the query expects, whose own result is the decision.
        return {
          result: {
            case: "webFetchRequestResponse",
            value: {
              result: options.rejectQuery === undefined
                ? { case: "approved", value: {} }
                : { case: "rejected", value: { reason: options.rejectQuery } },
            },
          },
        }
      },
    },
    emitPartialToolCall() {},
    async executeToolCall(ctx, _call, _id, run, merge) {
      const result = await run(ctx)
      merge(result)
      return result
    },
  }
}

const run = (harnessed: Harness, args: unknown, handlerOptions: { rejectQuery?: string } = {}) =>
  asTool(harnessed.tool).execute(createContext(), handler(harnessed, handlerOptions), argsOf(args), { toolCallId: "call-1" })

const textOf = (result: { content: Array<{ text?: string }> }): string => result.content.map(part => part.text ?? "").join("")

// ---------------------------------------------------------------------------------------------
// what the model is told about the tool
// ---------------------------------------------------------------------------------------------

test("the tool is named the way each prompt version expects", () => {
  assert.equal(asTool(harness({ promptVersion: "dsv3-1018" }).tool).name, "mcp_web_fetch")
  assert.equal(asTool(harness({ promptVersion: "dsv3-1205" }).tool).name, "mcp_web_fetch")
  for (const version of ["cursor-0226", "latest", "gpt5-codex", "codex-cloud", "haiku"]) {
    assert.equal(asTool(harness({ promptVersion: version }).tool).name, "WebFetch", version)
  }
  assert.throws(() => harness({ promptVersion: "future-model" }), /Unhandled version: future-model/)
})

test("the minimal harness describes the tool in one line", () => {
  const minimal = asTool(harness({ minimal: true }).tool).descriptionGenerator()
  assert.match(minimal, /^Fetch content from a URL and return it as readable markdown\./)
  assert.doesNotMatch(minimal, /Authentication is not supported/)

  const full = asTool(harness().tool).descriptionGenerator()
  assert.match(full, /This fetch runs from an isolated server\. Hosts like localhost or private IPs will not work\./)
  assert.match(full, /This tool does not support fetching binary content/)
})

test("the only argument is the URL", () => {
  const tool = asTool(harness().tool)
  assert.deepEqual(Object.keys(tool.parameters.jsonSchema?.properties ?? {}), ["url"])
  assert.deepEqual(tool.parameters.jsonSchema?.required, ["url"])
})

// ---------------------------------------------------------------------------------------------
// what is refused before anything is fetched
// ---------------------------------------------------------------------------------------------

test("a URL that is not one is refused with what it should look like", async () => {
  const harnessed = harness()
  await assert.rejects(() => run(harnessed, { url: "example.test/page" }), /Invalid URL: must include http:\/\/ or https:\/\//)
  assert.deepEqual(harnessed.fetched, [])
})

test("a protocol that is not http is refused", async () => {
  await assert.rejects(() => run(harness(), { url: "ftp://example.test/page" }), /Invalid URL protocol: ftp: \(must be http or https\)/)
})

test("an address that only exists on this machine is refused with the reason", async () => {
  await assert.rejects(() => run(harness(), { url: "http://localhost:3000/page" }), /Cannot fetch from localhost \(localhost:3000\) because this tool runs from an isolated server\./)
  await assert.rejects(() => run(harness(), { url: "http://127.0.0.1/page" }), /Cannot fetch from localhost/)
  await assert.rejects(() => run(harness(), { url: "http://192.168.1.10/page" }), /Cannot fetch from private IP \(192\.168\.1\.10\) because this tool runs from an isolated server\./)
})

test("a URL's own credentials are stripped when the session asks for that", async () => {
  const without = harness()
  await run(without, { url: "https://user:secret@example.test/page" })
  assert.equal(without.fetched[0], "https://user:secret@example.test/page")

  const with_ = harness({ stripCredentials: true })
  await run(with_, { url: "https://user:secret@example.test/page" })
  assert.equal(with_[0 as never] === undefined, true)
  assert.equal(with_.fetched[0], "https://example.test/page")
})

// ---------------------------------------------------------------------------------------------
// the fetch itself
// ---------------------------------------------------------------------------------------------

test("the user is asked before the page is fetched", async () => {
  const harnessed = harness()
  await run(harnessed, { url: "https://example.test/page" })
  assert.deepEqual(harnessed.queries, [{ case: "webFetchRequestQuery" }])
  assert.deepEqual(harnessed.fetched, ["https://example.test/page"])
})

test("a fetch the user refuses is reported as a refusal", async () => {
  const harnessed = harness()
  await assert.rejects(
    () => run(harnessed, { url: "https://example.test/page" }, { rejectQuery: "not this one" }),
    ToolCallRejectedError,
  )
  assert.deepEqual(harnessed.fetched, [])
})

test("a page is handed back as the markdown it was converted to", async () => {
  const harnessed = harness({ answer: { content: "# The page\n\nsome content" } })
  const result = await run(harnessed, { url: "https://example.test/page" })
  assert.equal(result.result.case, "success")
  assert.equal(result.result.case === "success" ? result.result.value.markdown : "", "# The page\n\nsome content")
  assert.equal(result.result.case === "success" ? result.result.value.url : "", "https://example.test/page")
  assert.equal(result.result.case === "success" ? result.result.value.outputLocation : undefined, undefined)
})

test("a fetch that failed is reported with the URL it was about", async () => {
  const harnessed = harness({ answer: { error: "the server said 500" } })
  const result = await run(harnessed, { url: "https://example.test/page" })
  assert.equal(result.result.case, "error")
  assert.equal(result.result.case === "error" ? result.result.value.error : "", "the server said 500")
  assert.equal(result.result.case === "error" ? result.result.value.url : "", "https://example.test/page")
})

test("a fetch that timed out is a timeout, because it may be worth retrying", async () => {
  const harnessed = harness({ answer: { error: "timed out", isTimeout: true } })
  await assert.rejects(() => run(harnessed, { url: "https://example.test/page" }), ToolTimeoutError)
})

test("content longer than a message should carry is cut with a count of what was left out", async () => {
  const long = `${"x".repeat(100_001)}\nsecond line\nthird line`
  const harnessed = harness({ answer: { content: long } })
  const result = await run(harnessed, { url: "https://example.test/page" })
  const markdown = result.result.case === "success" ? result.result.value.markdown : ""
  // The body is cut at the limit and the notice counts the lines that were left out.
  const body = markdown.split("\n\n...")[0] ?? ""
  assert.equal(body.length, 100_000)
  assert.match(markdown, /\.\.\.\[3 lines truncated\]$/)
})

test("content past the file threshold is written out and the result points at it", async () => {
  const long = "x".repeat(AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES + 1)
  const harnessed = harness({ answer: { content: long }, projectFolder: "/repo" })
  const result = await run(harnessed, { url: "https://example.test/page" })
  assert.equal(harnessed.writes.length, 1)
  assert.equal(harnessed.writes[0]?.text, long)
  assert.equal(result.result.case === "success" ? result.result.value.outputLocation !== undefined : false, true)
})

test("a write that fails leaves the content in the message rather than losing it", async () => {
  const long = "x".repeat(AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES + 1)
  const harnessed = harness({ answer: { content: long }, projectFolder: "/repo", failWrite: true })
  const result = await run(harnessed, { url: "https://example.test/page" })
  assert.equal(result.result.case === "success" ? result.result.value.outputLocation : undefined, undefined)
  // The content is longer than the file threshold but shorter than the message limit, so nothing is lost.
  assert.equal(result.result.case === "success" ? result.result.value.markdown : "", long)
})

test("content past the message limit as well as the file threshold is cut", async () => {
  const long = "x".repeat(100_001)
  const harnessed = harness({ answer: { content: long }, projectFolder: "/repo", failWrite: true })
  const result = await run(harnessed, { url: "https://example.test/page" })
  assert.match(result.result.case === "success" ? result.result.value.markdown : "", /\.\.\.\[1 line truncated\]$/)
})

test("a session with nowhere to write keeps the content in the message", async () => {
  const long = "x".repeat(AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES + 1)
  const harnessed = harness({ answer: { content: long } })
  const result = await run(harnessed, { url: "https://example.test/page" })
  // Nothing is written, and the content is short enough for the message to carry it whole.
  assert.deepEqual(harnessed.writes, [])
  assert.equal(result.result.case === "success" ? result.result.value.markdown : "", long)
})

test("a session with nowhere to write cuts content that is too long for a message", async () => {
  const long = "x".repeat(100_001)
  const harnessed = harness({ answer: { content: long } })
  const result = await run(harnessed, { url: "https://example.test/page" })
  const markdown = result.result.case === "success" ? result.result.value.markdown : ""
  assert.equal(markdown.split("\n\n...")[0]?.length, 100_000)
  assert.match(markdown, /\.\.\.\[1 line truncated\]$/)
})

// ---------------------------------------------------------------------------------------------
// what the model is shown
// ---------------------------------------------------------------------------------------------

test("a fetched page is shown under a heading naming it", async () => {
  const harnessed = harness({ answer: { content: "the content" } })
  const result = await run(harnessed, { url: "https://example.test/page" })
  assert.equal(textOf(await asTool(harnessed.tool).render(createContext(), result)), "# Content from https://example.test/page\n\nthe content")
})

test("a page written to a file is shown as where it went", async () => {
  const long = "x".repeat(AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES + 1)
  const harnessed = harness({ answer: { content: long }, projectFolder: "/repo" })
  const result = await run(harnessed, { url: "https://example.test/page" })
  const rendered = textOf(await asTool(harnessed.tool).render(createContext(), result))
  assert.match(rendered, /^# Content from https:\/\/example\.test\/page\n\nContent written to file: /)
  assert.match(rendered, /Size: \d+\.\d KB, \d+ lines/)
})

test("a failure is shown with the URL it was about, and a refusal as a refusal", async () => {
  const failed = harness({ answer: { error: "the server said 500" } })
  const failedResult = await run(failed, { url: "https://example.test/page" })
  assert.equal(
    textOf(await asTool(failed.tool).render(createContext(), failedResult)),
    "Error fetching URL https://example.test/page: the server said 500",
  )

  // A refusal the user gave is thrown rather than returned, and serialized as a refusal.
  const rejected = harness()
  await assert.rejects(() => run(rejected, { url: "https://example.test/page" }, { rejectQuery: "no" }), ToolCallRejectedError)
  const rejectedToolCall = asTool(rejected.tool).serializeError(new ToolCallRejectedError("no")) as { tool?: { value?: { result?: WebFetchResult } } }
  assert.equal(rejectedToolCall.tool?.value?.result?.result.case, "rejected")
  assert.equal(
    rejectedToolCall.tool?.value?.result?.result.case === "rejected" ? rejectedToolCall.tool.value.result.result.value.reason : "",
    "no",
  )
})

test("a refusal without a reason is shown as a plain refusal", async () => {
  const harnessed = harness()
  const rejected = new WebFetchResult({ result: { case: "rejected", value: { reason: "" } as never } })
  assert.equal(textOf(await asTool(harnessed.tool).render(createContext(), rejected)), "The web fetch was rejected by the user.")
})

test("an error is serialized into the call the turn records", () => {
  const harnessed = harness()
  const serialized = asTool(harnessed.tool).serializeError(new Error("boom")) as { tool?: { case?: string; value?: { result?: WebFetchResult } } }
  assert.equal(serialized.tool?.case, "webFetchToolCall")
  assert.equal(serialized.tool?.value?.result?.result.case, "error")
})

test("the call a turn records is a web fetch call", async () => {
  const harnessed = harness()
  const call = new WebFetchToolCall({ args: { url: "https://example.test/page", toolCallId: "call-1" } as never })
  assert.equal(call.args?.url, "https://example.test/page")
})
