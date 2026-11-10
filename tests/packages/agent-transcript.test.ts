import { test } from "node:test"
import assert from "node:assert/strict"

import { TranscriptStore } from "../../source/host/transcript/agent-transcript/index.ts"
import { HistoryVisibilityMode, convertConversationMessagesToTrace } from "../../source/adapters/interop/agent/conversation-message-trace-adapter.ts"
import { stripContextTags, stripTags } from "../../source/host/transcript/agent-transcript/context-stripping.ts"
import { transcriptFilePath } from "../../source/host/transcript/agent-transcript/paths.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { ConversationMessage, ConversationMessage_MessageType } from "../../source/adapters/interop/proto/generated/aiserver/v1/chat_pb.ts"
import {
  createSlateConversationSummaryArchiveSerde,
  redactSlateConversationSummaryArchive,
} from "../../source/adapters/interop/agent/conversation-summary-storage-adapter.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"

// ---------------------------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------------------------

const encoder = new TextEncoder()

/** The blobs a session holds, addressed by the id the state carries. */
function blobStoreOf(blobs: Map<string, Uint8Array>) {
  return {
    async getBlob(_ctx: Context, blobId: Uint8Array): Promise<Uint8Array | undefined> {
      return blobs.get(new TextDecoder().decode(blobId))
    },
  }
}

const blobId = (name: string) => encoder.encode(name)

const message = (role: string, content: unknown, options: { isSummary?: boolean } = {}): Uint8Array =>
  encoder.encode(JSON.stringify({ role, content, ...(options.isSummary === true ? { providerOptions: { cursor: { isSummary: true } } } : {}) }))

function harness(options: {
  blobs?: Map<string, Uint8Array>
  state?: { mode?: string; rootPromptMessagesJson?: Uint8Array[]; summaryArchives?: Uint8Array[] }
  storeOptions?: Record<string, unknown>
} = {}) {
  const files = new Map<string, string>()
  const appends: string[] = []
  const store = new TranscriptStore(
    "/repo",
    blobStoreOf(options.blobs ?? new Map()) as never,
    async (path, content) => { files.set(path, content) },
    {
      pathResolver: (conversationId: string, ext: string) => `/repo/.slate/projects/workspace-1/agent-transcripts/${conversationId}/${conversationId}.${ext}`,
      appendFile: async (path: string, content: string) => { appends.push(content); files.set(path, (files.get(path) ?? "") + content) },
      ...options.storeOptions,
    },
  )
  const state = {
    mode: options.state?.mode ?? "agent",
    rootPromptMessagesJson: options.state?.rootPromptMessagesJson ?? [],
    summaryArchives: options.state?.summaryArchives ?? [],
  }
  return { store, files, appends, state }
}

const ctx = createContext()
const textFile = (harnessed: ReturnType<typeof harness>, conversationId = "conversation-1") =>
  harnessed.files.get(`/repo/.slate/projects/workspace-1/agent-transcripts/${conversationId}/${conversationId}.txt`)
const jsonlFile = (harnessed: ReturnType<typeof harness>, conversationId = "conversation-1") =>
  harnessed.files.get(`/repo/.slate/projects/workspace-1/agent-transcripts/${conversationId}/${conversationId}.jsonl`)

// ---------------------------------------------------------------------------------------------
// where a transcript lives
// ---------------------------------------------------------------------------------------------

test("a conversation's transcript file lives under its encoded id", () => {
  assert.equal(transcriptFilePath({ conversationId: "conversation-1", kind: "primary", ext: "jsonl" }), "agent-transcripts/conversation-1/conversation-1.jsonl")
})

test("a child transcript lives under its parent's history", () => {
  assert.equal(
    transcriptFilePath({ conversationId: "agent-1", kind: "subagent", parentConversationId: "conversation-1", ext: "jsonl" }),
    "agent-transcripts/conversation-1/subagents/agent-1.jsonl",
  )
})

test("an id that could address another directory is encoded", () => {
  const relative = transcriptFilePath({ conversationId: "../escape", kind: "primary", ext: "jsonl" })
  // The separator is gone, so what was a path is now one name — the dots are part of the name, not a step up.
  assert.equal(relative.startsWith("agent-transcripts/"), true)
  assert.deepEqual(relative.split("/").filter(part => part === ".."), [])
  assert.equal(relative.split("/").length, 3)
})

test("a child without a parent id stays in its own history", () => {
  assert.equal(
    transcriptFilePath({ conversationId: "agent-1", kind: "subagent", parentConversationId: "", ext: "jsonl" }),
    "agent-transcripts/agent-1/agent-1.jsonl",
  )
})

// ---------------------------------------------------------------------------------------------
// what is left out of a transcript
// ---------------------------------------------------------------------------------------------

test("the platform's own context is stripped from what is written", () => {
  const text = "hello\n<user_info>their profile</user_info>\n<git_status>clean</git_status>\nbye"
  assert.equal(stripContextTags(text), "hello\n\nbye")
})

test("a tag with attributes and a tag spanning lines are both stripped", () => {
  assert.equal(stripTags("a<rules type=\"x\">one\ntwo</rules>b", ["rules"]), "ab")
  assert.equal(stripTags("a<rules>one</rules>b", ["rules"]), "ab")
})

test("stripping leaves the text alone when there is nothing to strip", () => {
  assert.equal(stripContextTags("just the user's words"), "just the user's words")
})

// ---------------------------------------------------------------------------------------------
// writing the transcript
// ---------------------------------------------------------------------------------------------

test("a conversation is written as text with its roles", async () => {
  const blobs = new Map([
    ["a", message("user", "hello")],
    ["b", message("assistant", "hi there")],
  ])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a"), blobId("b")] } })
  assert.equal(await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1"), true)
  assert.equal(textFile(harnessed), "user:\nhello\n\nassistant:\nhi there")
  // The default store writes only the text form.
  assert.equal(harnessed.files.size, 1)
})

test("a transcript written as nothing is not a failure", async () => {
  const harnessed = harness()
  assert.equal(await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1"), true)
  assert.deepEqual([...harnessed.files.keys()], [])
})

test("a tool result is written without a role heading", async () => {
  const blobs = new Map([["a", message("tool", "[Tool result] Read")]])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a")] } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1")
  assert.equal(textFile(harnessed), "[Tool result] Read")
})

test("the summary messages and the system messages are not part of the conversation", async () => {
  const blobs = new Map([
    ["a", message("system", "the platform's preamble")],
    ["b", message("user", "hello")],
    ["c", message("assistant", "a summary", { isSummary: true })],
  ])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a"), blobId("b"), blobId("c")] } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1")
  assert.equal(textFile(harnessed), "user:\nhello")
})

test("the two opening user messages are the preamble and the user's own", async () => {
  const blobs = new Map([
    ["a", message("user", "the platform's framing")],
    ["b", message("user", "the actual question")],
  ])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a"), blobId("b")] } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1")
  assert.equal(textFile(harnessed), "user:\nthe actual question")
})

test("a part the transcript cannot show is written as a note", async () => {
  const blobs = new Map([["a", message("assistant", [
    { type: "text", text: "here is the picture" },
    { type: "image" },
    { type: "file", filename: "report.pdf" },
    { type: "reasoning", text: "thinking about it" },
    { type: "tool-call", toolName: "Read", args: { path: "/repo/a.ts", count: 2, nested: { a: 1 } } },
    { type: "tool-result", toolName: "Read" },
  ])]])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a")] } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1")
  const written = textFile(harnessed) ?? ""
  assert.match(written, /\[Image\]/)
  assert.match(written, /\[File: report\.pdf\]/)
  assert.match(written, /\[Thinking\] thinking about it/)
  assert.match(written, /\[Tool call\] Read\n {2}path: \/repo\/a\.ts/)
  assert.match(written, / {2}count: 2/)
  assert.match(written, / {2}nested: \{"a":1\}/)
  assert.match(written, /\[Tool result\] Read/)
})

test("hidden reasoning is not part of what the assistant said", async () => {
  const blobs = new Map([["a", message("assistant", "visible\u003cthinking\u003ehidden reasoning\u003c/thinking\u003emore visible")]])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a")] } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1")
  const written = textFile(harnessed) ?? ""
  assert.match(written, /visible/)
  assert.match(written, /more visible/)
  assert.equal(written.includes("hidden reasoning"), false)
})

test("a summary archive is written before the messages that are still live", async () => {
  const archive = createSlateConversationSummaryArchiveSerde(PrivacyMode.NO_STORAGE).serialize(
    redactSlateConversationSummaryArchive({
      summarizedMessageBlobIds: [blobId("old")],
      summary: "",
      summaryMessageBlobId: new Uint8Array(),
      unsummarizedWindowTail: 0,
    }, PrivacyMode.NO_STORAGE),
  )
  const blobs = new Map([
    ["old", message("user", "the earlier question")],
    ["live", message("user", "the latest question")],
    ["archive", archive],
  ])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("live")], summaryArchives: [blobId("archive")] } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1")
  const written = textFile(harnessed) ?? ""
  assert.equal(written.indexOf("the earlier question") < written.indexOf("the latest question"), true)
})

test("a blob that cannot be read is left out rather than failing the transcript", async () => {
  const blobs = new Map([
    ["broken", encoder.encode("this is not json")],
    ["good", message("user", "hello")],
  ])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("broken"), blobId("good")] } })
  assert.equal(await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1"), true)
  assert.equal(textFile(harnessed), "user:\nhello")
})

test("an enormous blob is replaced by a note saying how large it was", async () => {
  const huge = encoder.encode(`"${"x".repeat(5_000_001)}"`)
  const blobs = new Map([
    ["huge", huge],
    ["good", message("user", "hello")],
  ])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("huge"), blobId("good")] } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1")
  const written = textFile(harnessed) ?? ""
  assert.match(written, /\[Oversize transcript blob omitted: 5\.0 MB\]/)
  assert.equal(written.includes("xxxx"), false)
})

test("binary data in a message is written as a note rather than as hex", async () => {
  const blob = encoder.encode(JSON.stringify({ role: "user", content: "hello", attachment: { __type: "Uint8Array", hex: "deadbeef" } }))
  const harnessed = harness({ blobs: new Map([["a", blob]]), state: { rootPromptMessagesJson: [blobId("a")] } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1")
  assert.equal(textFile(harnessed), "user:\nhello")
})

// ---------------------------------------------------------------------------------------------
// the other two forms
// ---------------------------------------------------------------------------------------------

test("the JSON form carries the mode and the messages", async () => {
  const blobs = new Map([["a", message("user", "hello")]])
  const harnessed = harness({ blobs, state: { mode: "plan", rootPromptMessagesJson: [blobId("a")] }, storeOptions: { writeText: false, writeJson: true } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1")
  const written = JSON.parse(harnessed.files.get("/repo/.slate/projects/workspace-1/agent-transcripts/conversation-1/conversation-1.json") ?? "{}") as Record<string, unknown>
  assert.equal(written.mode, "plan")
  assert.deepEqual(written.messages, [{ role: "user", text: "hello" }])
})

test("the JSONL form writes one event per line", async () => {
  const blobs = new Map([
    ["a", message("user", "hello")],
    ["b", message("assistant", [{ type: "text", text: "looking" }, { type: "tool-call", toolName: "Read", args: { path: "/a" } }])],
  ])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a"), blobId("b")] }, storeOptions: { writeText: false, writeJsonl: true } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1")
  const lines = (jsonlFile(harnessed) ?? "").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>)
  assert.equal(lines.length, 2)
  assert.deepEqual(lines[0], { role: "user", message: { content: [{ type: "text", text: "hello" }] } })
  assert.deepEqual(lines[1], {
    role: "assistant",
    message: { content: [{ type: "text", text: "looking" }, { type: "tool_use", name: "Read", input: { path: "/a" } }] },
  })
})

test("how the turn ended is written in all three forms", async () => {
  const blobs = new Map([["a", message("user", "hello")]])
  const harnessed = harness({
    blobs,
    state: { rootPromptMessagesJson: [blobId("a")] },
    storeOptions: { writeText: true, writeJson: true, writeJsonl: true },
  })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1", { turnEnded: { status: "error", error: "the model refused" } })
  assert.match(textFile(harnessed) ?? "", /Turn ended: error: the model refused/)
  const json = JSON.parse(harnessed.files.get("/repo/.slate/projects/workspace-1/agent-transcripts/conversation-1/conversation-1.json") ?? "{}") as { turnEnded?: { status: string } }
  assert.equal(json.turnEnded?.status, "error")
  assert.match(jsonlFile(harnessed) ?? "", /"type":"turn_ended"/)
})

test("an overview is put at the top of the jsonl file", async () => {
  const blobs = new Map([["a", message("user", "hello")]])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a")] }, storeOptions: { writeText: false, writeJsonl: true } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1", { overviewFactory: async () => "what happened" })
  const first = (jsonlFile(harnessed) ?? "").split("\n")[0] ?? ""
  assert.equal(first, JSON.stringify({ type: "metadata", metadata: { overview: "what happened" } }))
})

test("an overview that cannot be made does not fail the transcript", async () => {
  const blobs = new Map([["a", message("user", "hello")]])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a")] }, storeOptions: { writeText: false, writeJsonl: true } })
  const written = await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1", { overviewFactory: async () => { throw new Error("no model") } })
  assert.equal(written, true)
  assert.match(jsonlFile(harnessed) ?? "", /"role":"user"/)
})

test("a transcript that cannot be written is reported rather than thrown", async () => {
  const blobs = new Map([["a", message("user", "hello")]])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a")] } })
  const failing = new TranscriptStore("/repo", blobStoreOf(blobs) as never, async () => { throw new Error("the disk is full") })
  assert.equal(await failing.writeFromStateFull(ctx, harnessed.state, "conversation-1"), false)
})

// ---------------------------------------------------------------------------------------------
// appending instead of rewriting
// ---------------------------------------------------------------------------------------------

test("only the new messages are appended when the file is already there", async () => {
  const blobs = new Map([
    ["a", message("user", "first")],
    ["b", message("assistant", "second")],
  ])
  const harnessed = harness({
    blobs,
    state: { rootPromptMessagesJson: [blobId("a"), blobId("b")] },
    storeOptions: { writeText: false, writeJsonl: true },
  })
  // One message was already written, so the count that follows is what is new.
  assert.equal(await harnessed.store.writeFromStateIncremental(ctx, harnessed.state, "conversation-1", 1), 2)
  assert.equal(harnessed.appends.length, 1)
  assert.match(harnessed.appends[0] ?? "", /second/)
  assert.equal((harnessed.appends[0] ?? "").includes("first"), false)
})

test("nothing new and nothing to say means nothing is written", async () => {
  const blobs = new Map([["a", message("user", "first")]])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a")] }, storeOptions: { writeText: false, writeJsonl: true } })
  assert.equal(await harnessed.store.writeFromStateIncremental(ctx, harnessed.state, "conversation-1", 1), 1)
  assert.deepEqual(harnessed.appends, [])
})

test("a turn marker is appended even when there is nothing else to append", async () => {
  const blobs = new Map([["a", message("user", "first")]])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a")] }, storeOptions: { writeText: false, writeJsonl: true } })
  await harnessed.store.writeFromStateIncremental(ctx, harnessed.state, "conversation-1", 1, { turnEnded: { status: "success" } })
  assert.equal(harnessed.appends.length, 1)
  assert.match(harnessed.appends[0] ?? "", /turn_ended/)
})

test("a file that is not there yet is written in full", async () => {
  const blobs = new Map([["a", message("user", "first")]])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a")] }, storeOptions: { writeText: false, writeJsonl: true } })
  // Nothing was written before, so there is nothing to append to.
  assert.equal(await harnessed.store.writeFromStateIncremental(ctx, harnessed.state, "conversation-1", 0), 1)
  assert.deepEqual(harnessed.appends, [])
  assert.match(jsonlFile(harnessed) ?? "", /first/)
})

test("an append that fails falls back to writing everything", async () => {
  const blobs = new Map([["a", message("user", "first")], ["b", message("user", "second")]])
  const harnessed = harness({
    blobs,
    state: { rootPromptMessagesJson: [blobId("a"), blobId("b")] },
    storeOptions: { writeText: false, writeJsonl: true, appendFile: async () => { throw new Error("no space left") } },
  })
  assert.equal(await harnessed.store.writeFromStateIncremental(ctx, harnessed.state, "conversation-1", 1), 2)
  assert.match(jsonlFile(harnessed) ?? "", /second/)
})

test("an append that fails is not retried when the caller has turned the fallback off", async () => {
  const blobs = new Map([["a", message("user", "first")], ["b", message("user", "second")]])
  const harnessed = harness({
    blobs,
    state: { rootPromptMessagesJson: [blobId("a"), blobId("b")] },
    storeOptions: { writeText: false, writeJsonl: true, fallbackToFullWriteOnIncrementalFailure: false, appendFile: async () => { throw new Error("no space left") } },
  })
  assert.equal(await harnessed.store.writeFromStateIncremental(ctx, harnessed.state, "conversation-1", 1), 0)
  assert.equal(jsonlFile(harnessed), undefined)
})

test("appending is not attempted for the forms that cannot be appended to", async () => {
  const blobs = new Map([["a", message("user", "first")], ["b", message("user", "second")]])
  const harnessed = harness({
    blobs,
    state: { rootPromptMessagesJson: [blobId("a"), blobId("b")] },
    storeOptions: { writeText: true, writeJsonl: true },
  })
  await harnessed.store.writeFromStateIncremental(ctx, harnessed.state, "conversation-1", 1)
  assert.deepEqual(harnessed.appends, [])
  assert.match(textFile(harnessed) ?? "", /second/)
})

// ---------------------------------------------------------------------------------------------
// a conversation as a trace
// ---------------------------------------------------------------------------------------------

const conversationMessage = (type: ConversationMessage_MessageType, fields: Record<string, unknown> = {}) =>
  new ConversationMessage({ type, text: "", toolResults: [], ...fields } as never)

test("a trace is the conversation with each call and result on its own row", () => {
  const messages = [
    conversationMessage(ConversationMessage_MessageType.HUMAN, { text: "hello" }),
    conversationMessage(ConversationMessage_MessageType.AI, {
      text: "looking",
      toolResults: [{
        toolCallId: "call-1",
        toolName: "Read",
        rawArgs: JSON.stringify({ path: "/repo/a.ts" }),
        content: JSON.stringify({ ok: true }),
        startedAtMs: 1_000n,
        completedAtMs: 1_250n,
      }],
    }),
  ]
  const trace = convertConversationMessagesToTrace(messages, HistoryVisibilityMode.INTERNAL)
  assert.deepEqual(trace.map(entry => entry.role), ["system", "assistant", "tool"])
  assert.equal(trace[1]?.text, "looking")
  assert.deepEqual(trace[1]?.tool_calls, [{ tool_call_id: "call-1", tool_name: "Read", tool_args: { path: "/repo/a.ts" }, started_at_ms: 1_000, completed_at_ms: 1_250, duration_ms: 250 }])
  assert.deepEqual(trace[2]?.tool_result, { ok: true })
  assert.equal(trace[2]?.duration_ms, 250)
})

test("an external trace starts after the preamble", () => {
  const messages = [
    conversationMessage(ConversationMessage_MessageType.HUMAN, { text: "the preamble" }),
    conversationMessage(ConversationMessage_MessageType.HUMAN, { text: "the platform's framing" }),
    conversationMessage(ConversationMessage_MessageType.HUMAN, { text: "the question" }),
  ]
  const trace = convertConversationMessagesToTrace(messages, HistoryVisibilityMode.EXTERNAL)
  assert.deepEqual(trace.map(entry => entry.text), ["the question"])
  assert.equal(trace[0]?.role, "user")
})

test("a message that is neither side is its own role", () => {
  const trace = convertConversationMessagesToTrace([conversationMessage(ConversationMessage_MessageType.UNSPECIFIED)], HistoryVisibilityMode.NO_PREAMBLE)
  assert.equal(trace[0]?.role, "unknown")
})

test("a tool result with no content carries the shape of what it returned", () => {
  const messages = [
    conversationMessage(ConversationMessage_MessageType.AI, {
      toolResults: [{ toolCallId: "call-1", toolName: "Read", result: { result: { case: "readFileResult", value: { contents: "the file" } } } }],
    }),
  ]
  const trace = convertConversationMessagesToTrace(messages, HistoryVisibilityMode.NO_PREAMBLE)
  const toolResult = trace[1]?.tool_result as { resultType: string; value: { contents: string } }
  assert.equal(toolResult.resultType, "readFileResult")
  assert.equal(toolResult.value.contents, "the file")
})

test("reasoning is carried on the message that has it", () => {
  const messages = [conversationMessage(ConversationMessage_MessageType.AI, { text: "the answer", thinking: { text: "the reasoning" } })]
  const trace = convertConversationMessagesToTrace(messages, HistoryVisibilityMode.NO_PREAMBLE)
  assert.equal(trace[0]?.thinking, "the reasoning")
  assert.equal(trace[0]?.text, "the answer")
})

test("a message with nothing in it is still a row", () => {
  const trace = convertConversationMessagesToTrace([conversationMessage(ConversationMessage_MessageType.AI, { text: "   " })], HistoryVisibilityMode.NO_PREAMBLE)
  assert.deepEqual(trace, [{ role: "assistant" }])
})

// ---------------------------------------------------------------------------------------------
// the shapes inside the forms
// ---------------------------------------------------------------------------------------------

const jsonFileOf = (harnessed: ReturnType<typeof harness>) =>
  JSON.parse(harnessed.files.get("/repo/.slate/projects/workspace-1/agent-transcripts/conversation-1/conversation-1.json") ?? "{}") as { mode?: string; messages?: unknown[]; turnEnded?: unknown }
const jsonlLinesOf = (harnessed: ReturnType<typeof harness>) =>
  (jsonlFile(harnessed) ?? "").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)

test("an unspecified mode is written as agent, like an unknown one", async () => {
  const blobs = new Map([["a", message("user", "hello")]])
  const unspecified = harness({ blobs, state: { mode: "unspecified", rootPromptMessagesJson: [blobId("a")] }, storeOptions: { writeText: false, writeJson: true } })
  await unspecified.store.writeFromStateFull(ctx, unspecified.state, "conversation-1")
  assert.equal(jsonFileOf(unspecified).mode, "agent")
  const unknown = harness({ blobs, state: { mode: "future-mode", rootPromptMessagesJson: [blobId("a")] }, storeOptions: { writeText: false, writeJson: true } })
  await unknown.store.writeFromStateFull(ctx, unknown.state, "conversation-1")
  assert.equal(jsonFileOf(unknown).mode, "agent")
})

test("the JSON form keeps each kind of part in its own place", async () => {
  const blobs = new Map([["a", message("assistant", [
    { type: "text", text: "the answer" },
    { type: "image" },
    { type: "file", filename: "report.pdf" },
    { type: "file" },
    { type: "reasoning", text: "first thought" },
    { type: "reasoning", text: "second thought" },
    { type: "redacted-reasoning" },
    { type: "tool-call", toolName: "Read", args: { path: "/repo/a.ts" } },
    { type: "tool-result", toolName: "Read" },
    { type: "unknown-kind", text: "invisible" },
  ])]])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a")] }, storeOptions: { writeText: false, writeJson: true } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1")
  assert.deepEqual(jsonFileOf(harnessed).messages, [{
    role: "assistant",
    text: "the answer\n[Image]\n[File: report.pdf]\n[File]",
    thinking: "first thought\nsecond thought\n[REDACTED]",
    toolCalls: [{ toolName: "Read", args: { path: "/repo/a.ts" } }],
    toolResult: { toolName: "Read" },
  }])
})

test("a message with nothing to show is not written to the JSON form", async () => {
  const blobs = new Map([
    ["a", message("assistant", [{ type: "text", text: "   " }])],
    ["b", message("assistant", [])],
  ])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a"), blobId("b")] }, storeOptions: { writeText: false, writeJson: true } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1")
  assert.equal(jsonFileOf(harnessed).messages, undefined)
  assert.equal(harnessed.files.size, 0)
})

test("a binary payload becomes a note saying how many bytes were dropped", async () => {
  const blob = encoder.encode(JSON.stringify({ role: "user", content: { __type: "Uint8Array", hex: "deadbeef" } }))
  const harnessed = harness({ blobs: new Map([["a", blob]]), state: { rootPromptMessagesJson: [blobId("a")] } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1")
  assert.equal(textFile(harnessed), "user:\n[Binary data omitted from transcript: 4 bytes]")
})

test("a turn status the transcript does not know is written as it came", async () => {
  const harnessed = harness({ state: { rootPromptMessagesJson: [] }, storeOptions: { writeText: true, writeJsonl: true } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1", { turnEnded: { status: "mystery", error: "why" } })
  assert.equal(textFile(harnessed), "[object Object]")
  assert.deepEqual(jsonlLinesOf(harnessed), [{ type: "turn_ended", status: "mystery", error: "why" }])
})

test("an error turn with no reason says its reason is undefined", async () => {
  const harnessed = harness({ state: { rootPromptMessagesJson: [] } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1", { turnEnded: { status: "error" } })
  assert.equal(textFile(harnessed), "Turn ended: error: undefined")
})

test("an archived summary message is written while an archived system one is not", async () => {
  const archive = createSlateConversationSummaryArchiveSerde(PrivacyMode.NO_STORAGE).serialize(
    redactSlateConversationSummaryArchive({
      summarizedMessageBlobIds: [blobId("s"), blobId("m")],
      summary: "",
      summaryMessageBlobId: new Uint8Array(),
      unsummarizedWindowTail: 0,
    }, PrivacyMode.NO_STORAGE),
  )
  const blobs = new Map([
    ["s", message("system", "the archived preamble")],
    ["m", message("assistant", "the archived summary", { isSummary: true })],
    ["arc", archive],
  ])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [], summaryArchives: [blobId("arc")] } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1")
  const written = textFile(harnessed) ?? ""
  assert.match(written, /the archived summary/)
  assert.equal(written.includes("the archived preamble"), false)
})

test("the JSONL form joins a message's words and its thinking with a blank line", async () => {
  const blobs = new Map([["a", message("assistant", [{ type: "text", text: "the answer" }, { type: "reasoning", text: "the reasoning" }])]])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a")] }, storeOptions: { writeText: false, writeJsonl: true } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1")
  assert.deepEqual(jsonlLinesOf(harnessed), [{ role: "assistant", message: { content: [{ type: "text", text: "the answer\n\nthe reasoning" }] } }])
})

test("a message with no showable part is left out of the JSONL form", async () => {
  const blobs = new Map([["a", message("assistant", [{ type: "unknown-kind", text: "invisible" }])]])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a")] }, storeOptions: { writeText: false, writeJsonl: true } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1")
  assert.equal(jsonlFile(harnessed), undefined)
})

test("the store names a transcript itself when it is given no resolver", async () => {
  const files = new Map<string, string>()
  const store = new TranscriptStore("/repo", blobStoreOf(new Map([["a", message("user", "hello")]])) as never, async (path, content) => { files.set(path, content) })
  await store.writeFromStateFull(ctx, { mode: "agent", rootPromptMessagesJson: [blobId("a")], summaryArchives: [] }, "conversation-1")
  assert.equal([...files.keys()][0], "/repo/agent-transcripts/conversation-1/conversation-1.txt")
})

test("a fallback append says why it fell back, and a refused one says why it did not", async () => {
  const blobs = new Map([["a", message("user", "first")], ["b", message("user", "second")]])
  const errors: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => { errors.push(args) }
  try {
    const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a"), blobId("b")] }, storeOptions: { writeText: false, writeJsonl: true, appendFile: async () => { throw new Error("no space left") } } })
    await harnessed.store.writeFromStateIncremental(ctx, harnessed.state, "conversation-1", 1)
    assert.match(String(errors[0]?.[0]), /falling back to full write/)
    assert.equal((errors[0]?.[1] as Error).message, "no space left")
    const refusing = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a"), blobId("b")] }, storeOptions: { writeText: false, writeJsonl: true, fallbackToFullWriteOnIncrementalFailure: false, appendFile: async () => { throw new Error("no space left") } } })
    await refusing.store.writeFromStateIncremental(ctx, refusing.state, "conversation-1", 1)
    assert.equal(String(errors[1]?.[0]).includes("falling back"), false)
    assert.match(String(errors[1]?.[0]), /Failed to append transcript:/)
  } finally {
    console.error = originalError
  }
})

test("a turn's ending is spelled out for each status it knows", async () => {
  const success = harness({ state: { rootPromptMessagesJson: [] } })
  await success.store.writeFromStateFull(ctx, success.state, "conversation-1", { turnEnded: { status: "success" } })
  assert.equal(textFile(success), "Turn ended: success.")
  const aborted = harness({ state: { rootPromptMessagesJson: [] } })
  await aborted.store.writeFromStateFull(ctx, aborted.state, "conversation-1", { turnEnded: { status: "aborted" } })
  assert.equal(textFile(aborted), "Turn ended: aborted.")
  const stopped = harness({ state: { rootPromptMessagesJson: [] } })
  await stopped.store.writeFromStateFull(ctx, stopped.state, "conversation-1", { turnEnded: { status: "aborted", error: "the user stopped it" } })
  assert.equal(textFile(stopped), "Turn ended: aborted: the user stopped it")
})

test("a turn that wrote nothing but its ending writes just that line", async () => {
  const harnessed = harness({ state: { rootPromptMessagesJson: [] }, storeOptions: { writeText: true, writeJson: true, writeJsonl: true } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1", { turnEnded: { status: "success" } })
  assert.equal(textFile(harnessed), "Turn ended: success.")
  const json = jsonFileOf(harnessed)
  assert.deepEqual({ mode: json.mode, messages: json.messages }, { mode: "agent", messages: [] })
  assert.deepEqual(jsonlLinesOf(harnessed), [{ type: "turn_ended", status: "success" }])
  assert.equal((jsonlFile(harnessed) ?? "").endsWith("\n"), true)
  assert.equal((jsonlFile(harnessed) ?? "").startsWith("\n"), false)
})

test("an unknown part says nothing, and hidden reasoning does not reach the forms", async () => {
  const blobs = new Map([
    ["a", message("assistant", [
      { type: "unknown-kind", text: "invisible" },
      { type: "text", text: "visible<thinking>hidden part</thinking>more" },
      { type: "text", text: "second line" },
    ])],
    ["b", message("assistant", "visible<thinking>hidden text</thinking>more")],
  ])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a"), blobId("b")] }, storeOptions: { writeText: true, writeJson: true } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1")
  const written = textFile(harnessed) ?? ""
  assert.equal(written.includes("invisible"), false)
  assert.equal(written.includes("hidden"), false)
  // A kind the surface does not have adds no note of its own.
  assert.equal(written.includes("?"), false)
  assert.match(written, /visible/)
  assert.match(written, /more/)
  assert.deepEqual(jsonFileOf(harnessed).messages, [{ role: "assistant", text: "visiblemore\nsecond line" }, { role: "assistant", text: "visiblemore" }])
})

test("a user's own text keeps the thinking tags it came with", async () => {
  const kept = "kept\u003cthinking\u003ekept tag\u003c/thinking\u003e"
  const blobs = new Map([["a", message("user", [{ type: "text", text: kept }])]])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a")] }, storeOptions: { writeText: true, writeJson: true } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1")
  const written = textFile(harnessed) ?? ""
  assert.equal(written.includes("\u003cthinking\u003e"), true)
  assert.equal(written.includes("kept tag"), true)
  assert.equal((jsonFileOf(harnessed).messages?.[0] as { text?: string }).text?.includes("\u003cthinking\u003e"), true)
})

test("a blob of exactly the threshold size is read rather than omitted", async () => {
  const overhead = encoder.encode(JSON.stringify({ role: "user", content: "" })).length
  const boundary = encoder.encode(JSON.stringify({ role: "user", content: "x".repeat(5_000_000 - overhead) }))
  assert.equal(boundary.length, 5_000_000)
  const harnessed = harness({ blobs: new Map([["a", boundary]]), state: { rootPromptMessagesJson: [blobId("a")] } })
  const written = await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1")
  assert.equal(written, true)
  assert.equal((textFile(harnessed) ?? "").startsWith("user:\nxxxxxxxx"), true)
})

test("a write that fails says so, and a failed overview says that too", async () => {
  const errors: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => { errors.push(args) }
  try {
    const failing = harness({ blobs: new Map([["a", message("user", "hello")]]), state: { rootPromptMessagesJson: [blobId("a")] } })
    const broken = new TranscriptStore("/repo", blobStoreOf(new Map([["a", message("user", "hello")]])) as never, async () => { throw new Error("the disk is full") })
    await broken.writeFromStateFull(ctx, failing.state, "conversation-1")
    assert.match(String(errors[0]?.[0]), /Failed to write transcript:/)
    assert.equal((errors[0]?.[1] as Error).message, "the disk is full")
    const overview = harness({ blobs: new Map([["a", message("user", "hello")]]), state: { rootPromptMessagesJson: [blobId("a")] }, storeOptions: { writeText: false, writeJsonl: true } })
    await overview.store.writeFromStateFull(ctx, overview.state, "conversation-1", { overviewFactory: async () => { throw new Error("no model") } })
    assert.match(String(errors[1]?.[0]), /Failed to generate transcript overview:/)
  } finally {
    console.error = originalError
  }
})

test("a store with no append path writes everything instead", async () => {
  const blobs = new Map([["a", message("user", "first")], ["b", message("user", "second")]])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a"), blobId("b")] }, storeOptions: { writeText: false, writeJsonl: true, appendFile: undefined } })
  assert.equal(await harnessed.store.writeFromStateIncremental(ctx, harnessed.state, "conversation-1", 1), 2)
  assert.deepEqual(harnessed.appends, [])
  assert.match(jsonlFile(harnessed) ?? "", /second/)
})

test("an overview means the file is written again rather than appended to", async () => {
  const blobs = new Map([["a", message("user", "first")]])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a")] }, storeOptions: { writeText: false, writeJsonl: true } })
  assert.equal(await harnessed.store.writeFromStateIncremental(ctx, harnessed.state, "conversation-1", 1, { overviewFactory: async () => "what happened" }), 1)
  assert.deepEqual(harnessed.appends, [])
  assert.equal((jsonlFile(harnessed) ?? "").split("\n")[0]?.includes("metadata"), true)
})

test("an appended marker ends with a newline, and appended messages that show nothing append nothing", async () => {
  const blobs = new Map([["a", message("user", "first")]])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a")] }, storeOptions: { writeText: false, writeJsonl: true } })
  await harnessed.store.writeFromStateIncremental(ctx, harnessed.state, "conversation-1", 1, { turnEnded: { status: "success" } })
  assert.equal(harnessed.appends.length, 1)
  assert.equal((harnessed.appends[0] ?? "").endsWith("\n"), true)
  const unshowable = harness({ blobs: new Map([["a", message("user", "first")], ["s", message("system", "system only")]]), state: { rootPromptMessagesJson: [blobId("a"), blobId("s")] }, storeOptions: { writeText: false, writeJsonl: true } })
  assert.equal(await unshowable.store.writeFromStateIncremental(ctx, unshowable.state, "conversation-1", 1), 2)
  assert.deepEqual(unshowable.appends, [])
})
