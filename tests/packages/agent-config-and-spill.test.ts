import { test } from "node:test"
import assert from "node:assert/strict"

import { normalizeAgentConfig } from "../../source/packages/agent/agent-config-runtime.ts"
import {
  estimateTokenCount as estimateSelfSummaryTokenCount,
  extractTextContent,
} from "../../source/packages/agent/self-summary/token-estimate.ts"
import { spillLargeMcpTextOutput } from "../../source/adapters/interop/agent/mcp-output-spill-adapter.ts"
import { MAX_AGENT_STEPS } from "../../source/packages/agent/constants.ts"
import { DISABLED_BACKGROUND_SUMMARIZATION_PROPS } from "../../source/packages/agent-summarization/background-summarization.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { createRedactedString } from "../../source/packages/redaction/create.ts"
import { DataClassification } from "../../source/packages/redaction/classification.ts"
import { toRedactedCoreMessage } from "../../source/packages/redaction/message-redaction.ts"
import {
  McpResult,
  McpSuccess,
  McpTextContent,
  McpToolResultContentItem,
} from "../../source/adapters/interop/proto/generated/agent/v1/mcp_exec_pb.ts"
import { MCP_TEXT_FILE_THRESHOLD_BYTES } from "../../source/packages/agent/tools/mcp/mcp-output-spill-policy.ts"
import { writeExecutorResource } from "../../source/packages/agent-exec/write-operation.ts"

// ---------------------------------------------------------------------------------------------
// the defaults a session is given
// ---------------------------------------------------------------------------------------------

test("a session's own configuration is applied over the defaults", () => {
  const config = normalizeAgentConfig({
    systemPromptGenerator: () => "the prompt",
    maxSteps: 7,
    enableAgentNotes: true,
    formattingOptions: { shouldUseFormatCodeblock: false },
  })
  assert.equal(config.maxSteps, 7)
  assert.equal(config.enableAgentNotes, true)
  // A whole field that was given replaces the default rather than merging with it.
  assert.deepEqual(config.formattingOptions, { shouldUseFormatCodeblock: false })
})

test("everything a session did not mention has a value", () => {
  const config = normalizeAgentConfig({ systemPromptGenerator: () => "the prompt" })
  assert.equal(config.maxSteps, MAX_AGENT_STEPS)
  assert.equal(config.enableTerminalFiles, true)
  assert.equal(config.enableImageFiles, false)
  assert.equal(config.enableLongCodeSelectionSpillToFile, true)
  assert.equal(config.enableToolArgPreservation, true)
  assert.equal(config.strictArgParsing, false)
  assert.equal(config.enableExecuteHookExec, false)
  assert.equal(config.immediatelyUpdateStateOnNewTurn, false)
  assert.equal(config.smartModeClassifierMode, false)
  assert.equal(config.doNotFailOnMaxSteps, false)
  assert.equal(config.backgroundSummarizationProps, DISABLED_BACKGROUND_SUMMARIZATION_PROPS)
  // The generators produce nothing until a mode asks for something.
  assert.equal(config.planSystemReminderGenerator(), "")
  assert.equal(config.askSystemReminderGenerator({}), "")
  assert.equal(config.debugSystemReminderGenerator(undefined, true), "")
  assert.equal(config.triageSystemReminderGenerator(), "")
  assert.equal(config.projectSystemReminderGenerator(), "")
  assert.deepEqual(config.nonFileRules, [])
})

test("a session with no instructions at all is refused rather than defaulted", () => {
  assert.throws(() => normalizeAgentConfig({}), /systemPromptGenerator is required/)
})

test("the rules a session carries are filtered by who the session is", () => {
  const config = normalizeAgentConfig({
    systemPromptGenerator: () => "the prompt",
    actorIdentity: { email: "someone@example.test" },
    nonFileRules: [
      { fullPath: "/repo/.cursor/rules/a.md", content: "a", scopedTo: ["someone@example.test"] },
      { fullPath: "/repo/.cursor/rules/b.md", content: "b", scopedTo: ["somebody-else@example.test"] },
      { fullPath: "/repo/.cursor/rules/c.md", content: "c" },
    ],
  })
  // The rule scoped to this session and the one scoped to nobody both survive.
  assert.deepEqual(config.nonFileRules.map((rule: { fullPath: string }) => rule.fullPath), [
    "/repo/.cursor/rules/a.md",
    "/repo/.cursor/rules/c.md",
  ])
})

// ---------------------------------------------------------------------------------------------
// how big a summary's input is
// ---------------------------------------------------------------------------------------------

const redactedMessage = (role: string, text: string) => toRedactedCoreMessage({ role, content: text }, PrivacyMode.NO_STORAGE) as never

test("thinking is not counted, because a summary never reads it", () => {
  const tag = `${String.fromCharCode(60)}think${String.fromCharCode(62)}`
  const close = `${String.fromCharCode(60)}/think${String.fromCharCode(62)}`
  const withThinking = redactedMessage("assistant", `${tag}${"t".repeat(1_000)}${close}the answer`)
  const extracted = extractTextContent(withThinking)
  assert.equal(extracted.unwrap("unsafe_always_allowed" as never), "the answer")

  // And a conversation that deliberated more is not counted as larger.
  const withoutThinking = redactedMessage("assistant", "the answer")
  assert.equal(estimateSelfSummaryTokenCount([withThinking]), estimateSelfSummaryTokenCount([withoutThinking]))
})

test("the estimate counts the text a summary will read", () => {
  const message = redactedMessage("user", "x".repeat(100))
  // The platform's estimate, over the text this module extracted.
  assert.equal(estimateSelfSummaryTokenCount([message]), Math.ceil((100 + 25) / 2.5))
})

test("a message that is not text at all counts only its own overhead", () => {
  const message = { content: [{ type: "image" }], _privacyMode: PrivacyMode.NO_STORAGE } as never
  assert.equal(extractTextContent(message).unwrap("unsafe_always_allowed" as never), "")
  assert.equal(estimateSelfSummaryTokenCount([message]), Math.ceil(25 / 2.5))
})

test("the text parts of a message are joined the way a reader would read them", () => {
  const message = {
    content: [
      { type: "text", text: createRedactedString("one", DataClassification.CODE, "text", PrivacyMode.NO_STORAGE) },
      { type: "image" },
      { type: "text", text: createRedactedString("two", DataClassification.CODE, "text", PrivacyMode.NO_STORAGE) },
    ],
    _privacyMode: PrivacyMode.NO_STORAGE,
  } as never
  assert.equal(extractTextContent(message).unwrap("unsafe_always_allowed" as never), "one\ntwo")
})

// ---------------------------------------------------------------------------------------------
// what to do with an output too large to hand back
// ---------------------------------------------------------------------------------------------

const textItem = (text: string, outputLocation?: unknown): McpToolResultContentItem =>
  new McpToolResultContentItem({
    content: {
      case: "text",
      value: new McpTextContent({ text, ...(outputLocation === undefined ? {} : { outputLocation: outputLocation as never }) }),
    },
  })

const successOf = (items: McpToolResultContentItem[]): McpResult =>
  new McpResult({ result: { case: "success", value: new McpSuccess({ content: items }) } })

interface SpillHarness {
  readonly writes: Array<{ path: string; text: string }>
  readonly resourceAccessor: { get(): { execute(ctx: Context, args: { path: string; fileText?: string; fileBytes?: Uint8Array }): Promise<unknown> } }
}

function spillHarness(options: { failWrite?: boolean } = {}): SpillHarness {
  const writes: Array<{ path: string; text: string }> = []
  return {
    writes,
    resourceAccessor: {
      get: (resource?: unknown) => {
        void resource
        return {
          async execute(_ctx, args) {
            if (options.failWrite === true) return { result: { case: "error", value: { error: "the workspace is read-only" } } }
            // The writer sends text; bytes are the other form a write can take.
            const text = args.fileText ?? new TextDecoder().decode(args.fileBytes ?? new Uint8Array())
            writes.push({ path: args.path, text })
            return { result: { case: "success", value: { path: args.path } } }
          },
        }
      },
    },
  }
}

/** A session with no folder to write into is asked for by passing nothing, not by leaving the option out. */
const spill = (
  harnessed: SpillHarness,
  result: McpResult,
  options: { projectDir?: string | undefined; osPlatform?: string } = {},
) => spillLargeMcpTextOutput({
  ctx: createContext(),
  result,
  resourceAccessor: harnessed.resourceAccessor as never,
  projectDir: options.projectDir,
  osPlatform: options.osPlatform,
  toolCallId: "call-1",
})

test("a small output is handed back as it came", async () => {
  const harnessed = spillHarness()
  const result = successOf([textItem("a short answer")])
  const spilled = await spill(harnessed, result)
  assert.equal(spilled, result)
  assert.deepEqual(harnessed.writes, [])
})

test("a large output is written to a file and the result points at it", async () => {
  const harnessed = spillHarness()
  const large = "x".repeat(MCP_TEXT_FILE_THRESHOLD_BYTES + 1)
  const spilled = await spill(harnessed, successOf([textItem(large)]), { projectDir: "/repo" })
  assert.equal(spilled.result.case, "success")
  assert.equal(harnessed.writes.length, 1)
  assert.equal(harnessed.writes[0]?.text, large)
  assert.match(harnessed.writes[0]?.path ?? "", /agent-tools/)
  assert.equal(harnessed.writes[0]?.path.endsWith(".txt"), true)
  if (spilled.result.case !== "success") return
  const item = spilled.result.value.content[0]
  assert.equal(item?.content.case, "text")
  assert.notEqual(item?.content.case === "text" ? item.content.value.outputLocation : undefined, undefined)
})

test("a result that already points at a file is left alone", async () => {
  const harnessed = spillHarness()
  const large = "x".repeat(MCP_TEXT_FILE_THRESHOLD_BYTES + 1)
  const result = successOf([textItem("", { filePath: "/repo/already.txt", sizeBytes: 1n, lineCount: 1n })])
  const spilled = await spill(harnessed, result)
  assert.equal(spilled, result)
  assert.deepEqual(harnessed.writes, [])
})

test("a session with nowhere to write cuts the output and says so", async () => {
  const harnessed = spillHarness()
  const large = "x".repeat(MCP_TEXT_FILE_THRESHOLD_BYTES + 100)
  const spilled = await spill(harnessed, successOf([textItem(large)]), { projectDir: undefined })
  if (spilled.result.case !== "success") throw new Error("expected a success")
  const text = spilled.result.value.content[0]?.content.case === "text" ? spilled.result.value.content[0].content.value.text : ""
  // The body is cut to the inline limit, and the notice explaining why is added after it.
  const body = text.split("\n\n[Output truncated")[0] ?? ""
  assert.equal(body.length <= MCP_TEXT_FILE_THRESHOLD_BYTES, true)
  assert.equal(body.length < large.length, true)
  assert.match(text, /\[Output truncated: the full MCP tool output was \d+ bytes, which exceeds the inline limit of \d+ bytes, and could not be written to a file\./)
  assert.match(text, /do not retry the same call expecting the full output\./)
})

test("a write that fails cuts the output the same way", async () => {
  const harnessed = spillHarness({ failWrite: true })
  const large = "x".repeat(MCP_TEXT_FILE_THRESHOLD_BYTES + 100)
  const spilled = await spill(harnessed, successOf([textItem(large)]), { projectDir: "/repo" })
  if (spilled.result.case !== "success") throw new Error("expected a success")
  const text = spilled.result.value.content[0]?.content.case === "text" ? spilled.result.value.content[0].content.value.text : ""
  assert.match(text, /could not be written to a file/)
})

test("a cut lands on a character boundary rather than splitting one", async () => {
  const harnessed = spillHarness()
  // Three bytes per character, so a cut at the byte limit lands inside one.
  const large = "日".repeat(Math.ceil(MCP_TEXT_FILE_THRESHOLD_BYTES / 3) + 100)
  const spilled = await spill(harnessed, successOf([textItem(large)]), { projectDir: undefined })
  if (spilled.result.case !== "success") throw new Error("expected a success")
  const text = spilled.result.value.content[0]?.content.case === "text" ? spilled.result.value.content[0].content.value.text : ""
  const body = text.split("\n\n[Output truncated")[0] ?? ""
  assert.equal(body.includes("\uFFFD"), false)
  assert.equal(body.length > 0, true)
})

test("a failure that is not a success is passed through untouched", async () => {
  const harnessed = spillHarness()
  const failed = new McpResult({ result: { case: "error", value: { error: "the server refused" } as never } })
  assert.equal(await spill(harnessed, failed), failed)
  assert.deepEqual(harnessed.writes, [])
})

test("only the inline text is replaced when a result has other parts", async () => {
  const harnessed = spillHarness()
  const large = "x".repeat(MCP_TEXT_FILE_THRESHOLD_BYTES + 1)
  const image = new McpToolResultContentItem({ content: { case: "image", value: { data: new Uint8Array([1]), mimeType: "image/png" } as never } })
  const spilled = await spill(harnessed, successOf([textItem(large), image]))
  if (spilled.result.case !== "success") throw new Error("expected a success")
  // The image survives, and the text is cut rather than the whole result being replaced.
  assert.equal(spilled.result.value.content.length, 2)
  assert.equal(spilled.result.value.content[1]?.content.case, "image")
})
