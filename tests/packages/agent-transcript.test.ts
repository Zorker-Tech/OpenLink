import { test } from "node:test"
import assert from "node:assert/strict"

import { TranscriptStore } from "../../source/host/transcript/agent-transcript/index.ts"
import { HistoryVisibilityMode, convertConversationMessagesToTrace } from "../../source/host/transcript/agent-transcript/trace-format.ts"
import { stripContextTags, stripTags } from "../../source/host/transcript/agent-transcript/context-stripping.ts"
import { getTranscriptRelativePath } from "../../source/host/transcript/agent-transcript/paths.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { AgentMode, ConversationSummaryArchive } from "../../source/packages/proto/generated/agent/v1/agent_pb.ts"
import { ConversationMessage, ConversationMessage_MessageType } from "../../source/packages/proto/generated/aiserver/v1/chat_pb.ts"

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
  state?: { mode?: AgentMode; rootPromptMessagesJson?: Uint8Array[]; summaryArchives?: Uint8Array[] }
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
    mode: options.state?.mode ?? AgentMode.AGENT,
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

test("a conversation's transcript is named after the conversation", () => {
  assert.equal(getTranscriptRelativePath({ conversationId: "conversation-1", kind: "primary", ext: "jsonl" }), "agent-transcripts/conversation-1/conversation-1.jsonl")
})

test("a subagent's transcript lives under the conversation that started it", () => {
  assert.equal(
    getTranscriptRelativePath({ conversationId: "agent-1", kind: "subagent", parentConversationId: "conversation-1", ext: "jsonl" }),
    "agent-transcripts/conversation-1/subagents/agent-1.jsonl",
  )
})

test("an id that could address another directory is encoded", () => {
  const relative = getTranscriptRelativePath({ conversationId: "../escape", kind: "primary", ext: "jsonl" })
  // The separator is gone, so what was a path is now one name — the dots are part of the name, not a step up.
  assert.equal(relative.startsWith("agent-transcripts/"), true)
  assert.deepEqual(relative.split("/").filter(part => part === ".."), [])
  assert.equal(relative.split("/").length, 3)
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
    { type: "tool-call", toolName: "Read", args: { path: "/repo/a.ts" } },
    { type: "tool-result", toolName: "Read" },
  ])]])
  const harnessed = harness({ blobs, state: { rootPromptMessagesJson: [blobId("a")] } })
  await harnessed.store.writeFromStateFull(ctx, harnessed.state, "conversation-1")
  const written = textFile(harnessed) ?? ""
  assert.match(written, /\[Image\]/)
  assert.match(written, /\[File: report\.pdf\]/)
  assert.match(written, /\[Thinking\] thinking about it/)
  assert.match(written, /\[Tool call\] Read\n {2}path: \/repo\/a\.ts/)
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
  const archive = new ConversationSummaryArchive({ summarizedMessages: [blobId("old")] })
  const blobs = new Map([
    ["old", message("user", "the earlier question")],
    ["live", message("user", "the latest question")],
    ["archive", archive.toBinary()],
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
  const harnessed = harness({ blobs, state: { mode: AgentMode.PLAN, rootPromptMessagesJson: [blobId("a")] }, storeOptions: { writeText: false, writeJson: true } })
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
