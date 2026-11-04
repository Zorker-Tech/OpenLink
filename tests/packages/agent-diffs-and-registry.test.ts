import { test } from "node:test"
import assert from "node:assert/strict"

import { createContext } from "../../source/packages/context/context.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { CursorRule, CursorRuleSource } from "../../source/adapters/interop/proto/generated/agent/v1/rules_pb.ts"
import { ToolErrorClassification } from "../../source/packages/agent/tools/tool-errors.ts"
import { SubagentRegistry, subagentRegistryResource } from "../../source/packages/agent/tools/subagent-registry.ts"
import {
  ToolCountingStateTracker,
  createToolCountingMiddleware,
} from "../../source/packages/agent/tool-counting-middleware.ts"
import {
  DIFF_NO_BUDGET_MESSAGE,
  formatParsedDiffWithTruncation,
} from "../../source/packages/agent/diff-processing.ts"
import {
  buildGitDiffUncommittedUserContent,
  buildGitDiffUserContent,
} from "../../source/packages/agent/git-diff-processing.ts"
import { extractAutomationTriggerContext, getAllRules } from "../../source/packages/agent/actions/common.ts"
import { renderDirectoryTreeWithinBudget, type SlateDirectoryTreeNode } from "../../source/packages/agent/tools/core/ls/formatters.ts"

const ctx = () => createContext()

// ---------------------------------------------------------------------------------------------
// the subagent registry
// ---------------------------------------------------------------------------------------------

test("a subagent can be found by its own id and by the call that started it", () => {
  const registry = new SubagentRegistry()
  const handle = { cancel: () => {} }
  registry.register("sub-1", handle, "call-1")
  assert.equal(registry.get("sub-1"), handle)
  assert.equal(registry.has("sub-1"), true)
  assert.equal(registry.size, 1)
  assert.equal(registry.has("call-1"), false)
})

test("registering an id twice cancels the one that was there", () => {
  const registry = new SubagentRegistry()
  let cancelled = 0
  registry.register("sub-1", { cancel: () => { cancelled += 1 } }, "call-1")
  registry.register("sub-1", { cancel: () => {} }, "call-2")
  assert.equal(cancelled, 1)
  assert.equal(registry.size, 1)
  // The new registration owns the new call id, and the old one is gone.
  registry.cancel("call-1")
  assert.equal(registry.size, 1)
  registry.cancel("call-2")
  assert.equal(registry.size, 0)
})

test("cancelling by the tool call id reaches the subagent and forgets both ids", () => {
  const registry = new SubagentRegistry()
  let options: unknown
  registry.register("sub-1", { cancel: value => { options = value } }, "call-1")
  registry.cancel("call-1", { reason: "user" })
  assert.deepEqual(options, { reason: "user" })
  assert.equal(registry.size, 0)
  assert.deepEqual(registry.lastAbortOptions, { reason: "user" })
})

test("cancelling by the subagent id also clears its tool-call lookup", () => {
  const registry = new SubagentRegistry()
  let cancelled = 0
  registry.register("sub-1", { cancel: () => { cancelled += 1 } }, "call-1")

  registry.cancel("sub-1")
  registry.cancel("call-1")

  assert.equal(cancelled, 1)
  assert.equal(registry.size, 0)
})

test("a cancel that throws still forgets the subagent", () => {
  const registry = new SubagentRegistry()
  registry.register("sub-1", { cancel: () => { throw new Error("already gone") } })
  assert.throws(() => registry.cancel("sub-1"), /already gone/)
  assert.equal(registry.size, 0)
})

test("cancelling something unknown is not an error", () => {
  const registry = new SubagentRegistry()
  registry.cancel("nothing")
  assert.equal(registry.size, 0)
})

test("cleanup forgets a subagent without cancelling it", () => {
  const registry = new SubagentRegistry()
  let cancelled = 0
  registry.register("sub-1", { cancel: () => { cancelled += 1 } }, "call-1")
  registry.cleanup("sub-1")
  assert.equal(registry.size, 0)
  assert.equal(cancelled, 0)
})

test("cancelling everything honours the excluded calls, and a failing cancel is swallowed", () => {
  const registry = new SubagentRegistry()
  const cancelled: string[] = []
  registry.register("sub-1", { cancel: () => { cancelled.push("sub-1") } }, "call-1")
  registry.register("sub-2", { cancel: () => { cancelled.push("sub-2") } }, "call-2")
  registry.register("sub-3", { cancel: () => { throw new Error("gone") } }, "call-3")
  registry.cancelAll({ excludeToolCallIds: ["call-2"] })
  assert.deepEqual(cancelled, ["sub-1"])
  assert.equal(registry.size, 1)
  assert.equal(registry.has("sub-2"), true)
  registry.cancel("call-3")
  assert.equal(registry.size, 1)
})

test("the registry is a resource the environment provides", () => {
  assert.equal(typeof subagentRegistryResource.symbol, "symbol")
  assert.ok(subagentRegistryResource.remoteImplementation(undefined as never) instanceof SubagentRegistry)
})

// ---------------------------------------------------------------------------------------------
// counting tool calls
// ---------------------------------------------------------------------------------------------

test("the counts separate failures that are not the model's doing", () => {
  const state = new ToolCountingStateTracker()
  assert.equal(state.hasFailedToolCalls(), "false")
  assert.equal(state.getFailedToolCallCount(), 0)
  state.resultClassificationCounts.set(ToolErrorClassification.INVALID_ARGS, 2)
  assert.equal(state.hasUnexpectedToolCallErrors(), "false")
  state.resultClassificationCounts.set(ToolErrorClassification.TIMEOUT, 1)
  assert.equal(state.getFailedToolCallCount(), 3)
  assert.equal(state.getUnexpectedToolCallErrorCount(), 1)
  assert.equal(state.hasFailedToolCalls(), "true")
  assert.equal(state.hasUnexpectedToolCallErrors(), "true")
})

test("only environment and device failures count as unexpected", () => {
  const state = new ToolCountingStateTracker()
  state.resultClassificationCounts.set(ToolErrorClassification.TIMEOUT, 1)
  state.resultClassificationCounts.set(ToolErrorClassification.PROVIDER_ERROR, 2)
  state.resultClassificationCounts.set(ToolErrorClassification.BAD_USER_DEVICE_STATE, 3)
  state.resultClassificationCounts.set(ToolErrorClassification.OTHER_ERROR, 4)
  state.resultClassificationCounts.set(ToolErrorClassification.INVALID_ARGS, 5)

  assert.equal(state.getFailedToolCallCount(), 15)
  assert.equal(state.getUnexpectedToolCallErrorCount(), 10)
  assert.equal(state.hasUnexpectedToolCallErrors(), "true")
})

test("the middleware counts what the executor records, and forwards everything else", async () => {
  const state = new ToolCountingStateTracker()
  const recorded: unknown[] = []
  const forwarded: unknown[][] = []
  const forwardedModel: unknown[][] = []
  const forwardedStreams: unknown[][] = []
  const appended: unknown[][] = []
  let clearCount = 0
  const executor = {
    appendMessages: (...args: unknown[]) => { appended.push(args); return "appended" },
    getState: () => "state",
    getMessages: () => "messages",
    clearMessages: () => { clearCount += 1; return "cleared" },
    async executeToolStream(
      callContext: unknown,
      convState: unknown,
      interactionHandler: unknown,
      tools: unknown,
      extra: unknown,
      record: (ctx: unknown, result: unknown, name: unknown, classification: unknown) => Promise<void>,
      descriptionProps: unknown,
      firstToolCallHook: unknown,
    ) {
      forwarded.push([callContext, convState, interactionHandler, tools, extra, descriptionProps, firstToolCallHook])
      await record(callContext, "result", "shell", ToolErrorClassification.TIMEOUT)
      await record(callContext, "result", "shell", undefined)
      return "streamed"
    },
    executeModelStreamOnly: (...args: unknown[]) => { forwardedModel.push(args); return "model-only" },
    stream: (...args: unknown[]) => { forwardedStreams.push(args); return "stream" },
  }
  const wrapped = createToolCountingMiddleware(state)(executor as never) as unknown as {
    appendMessages: (...args: unknown[]) => unknown
    getState: () => unknown
    getMessages: () => unknown
    clearMessages: () => unknown
    executeModelStreamOnly: (...args: unknown[]) => unknown
    stream: (...args: unknown[]) => unknown
    executeToolStream: (
      a: unknown, b: unknown, c: unknown, d: unknown, e: unknown,
      record: (ctx: unknown, result: unknown, name: unknown, classification: unknown) => Promise<void>,
      descriptionProps?: unknown,
      firstToolCallHook?: unknown,
    ) => Promise<unknown>
  }
  // Appending is chainable and clearing is not, which is how the platform's own executor behaves.
  const callContext = ctx()
  const convState = { state: true }
  const interactionHandler = { handler: true }
  const tools = { tools: true }
  const extra = { extra: true }
  const descriptionProps = { description: true }
  const firstToolCallHook = () => {}
  const invocationId = "invocation-1"
  const streamOptions = { option: true }

  assert.equal(wrapped.appendMessages("message"), wrapped)
  assert.deepEqual(appended, [["message"]])
  assert.equal(wrapped.getState(), "state")
  assert.equal(wrapped.getMessages(), "messages")
  assert.equal(wrapped.clearMessages(), undefined)
  assert.equal(clearCount, 1)
  assert.equal(wrapped.executeModelStreamOnly(callContext, convState, interactionHandler, tools, descriptionProps, firstToolCallHook), "model-only")
  assert.equal(wrapped.stream(callContext, invocationId, tools, streamOptions), "stream")
  assert.deepEqual(forwardedModel, [[callContext, convState, interactionHandler, tools, descriptionProps, firstToolCallHook]])
  assert.deepEqual(forwardedStreams, [[callContext, invocationId, tools, streamOptions]])

  const result = await wrapped.executeToolStream(
    callContext, convState, interactionHandler, tools, extra,
    async (...args) => { recorded.push(args) },
    descriptionProps, firstToolCallHook,
  )
  assert.equal(result, "streamed")
  assert.deepEqual(forwarded, [[callContext, convState, interactionHandler, tools, extra, descriptionProps, firstToolCallHook]])
  assert.equal(state.toolCallCount, 2)
  assert.equal(state.getFailedToolCallCount(), 1)
  assert.equal(state.resultClassificationCounts.get(ToolErrorClassification.TIMEOUT), 1)
  assert.equal(recorded.length, 2)
})

test("a result is counted only after its recorder accepts it", async () => {
  const state = new ToolCountingStateTracker()
  const executor = {
    appendMessages() {}, getState() {}, getMessages() {}, clearMessages() {},
    async executeToolStream(
      _ctx: unknown, _state: unknown, _handler: unknown, _tools: unknown, _extra: unknown,
      record: (ctx: unknown, result: unknown, name: unknown, classification: unknown) => Promise<void>,
    ) {
      await assert.rejects(record(ctx(), "not stored", "shell", ToolErrorClassification.TIMEOUT), /store unavailable/)
      await record(ctx(), "stored", "shell", ToolErrorClassification.PROVIDER_ERROR)
    },
    executeModelStreamOnly() {}, stream() {},
  }
  const wrapped = createToolCountingMiddleware(state)(executor as never)
  await wrapped.executeToolStream(
    ctx(), {}, {}, {}, {},
    async (_innerCtx, result) => {
      if (result === "not stored") throw new Error("store unavailable")
    },
    {}, {},
  )

  assert.equal(state.toolCallCount, 1)
  assert.equal(state.resultClassificationCounts.get(ToolErrorClassification.TIMEOUT), undefined)
  assert.equal(state.resultClassificationCounts.get(ToolErrorClassification.PROVIDER_ERROR), 1)
  assert.equal(state.getFailedToolCallCount(), 1)
})

// ---------------------------------------------------------------------------------------------
// fitting a diff into a budget
// ---------------------------------------------------------------------------------------------

function parsedDiff(files: Array<[string, number]>): {
  preface: string
  files: Array<{ fileName: string; content: string }>
} {
  return {
    preface: "preface\n",
    files: files.map(([fileName, length]) => ({ fileName, content: `${fileName}\n${"x".repeat(length)}` })),
  }
}

test("a diff that fits is returned as it is", () => {
  const diff = parsedDiff([["a.ts", 10]])
  const formatted = formatParsedDiffWithTruncation(diff, 1_000)
  assert.equal(formatted, diff.preface + diff.files[0]!.content)
})

test("the smallest files are kept and the rest are named", () => {
  const diff = parsedDiff([["big.ts", 500], ["small.ts", 10], ["medium.ts", 200]])
  const formatted = formatParsedDiffWithTruncation(diff, 200)
  assert.match(formatted, /small\.ts/)
  assert.match(formatted, /The following files were also edited/)
  assert.match(formatted, /big\.ts/)
  assert.doesNotMatch(formatted, /x{500}/)
})

test("a budget too small for anything still says the diff was omitted", () => {
  assert.equal(formatParsedDiffWithTruncation(parsedDiff([["a.ts", 10]]), 0), DIFF_NO_BUDGET_MESSAGE)
  assert.equal(formatParsedDiffWithTruncation(parsedDiff([["a.ts", 10]]), -1), DIFF_NO_BUDGET_MESSAGE)
})

test("a diff with no per-file blocks is cut with a notice", () => {
  const formatted = formatParsedDiffWithTruncation({ preface: "x".repeat(500), files: [] }, 100)
  assert.match(formatted, /\[diff truncated due to size\]$/)
  assert.equal(formatted.length, 100)
})

test("a small budget cuts the content with a notice, and a tiny one shows nothing", () => {
  const diff = { preface: "x".repeat(500), files: [] }
  // Room for the notice: the content is cut and the notice ends it.
  assert.match(formatParsedDiffWithTruncation(diff, 40), /\[diff truncated due to size\]$/)
  // Not even room for the notice: nothing is shown, since a cut with no explanation would mislead.
  assert.equal(formatParsedDiffWithTruncation(diff, 31), "")
  // No budget at all is different: it says the diff was omitted rather than showing an empty block.
  assert.equal(formatParsedDiffWithTruncation(diff, 0), DIFF_NO_BUDGET_MESSAGE)
})

test("the summary names as many files as its own budget allows", () => {
  // All the excluded names fit here, so each is listed.
  const few = parsedDiff([["a.ts", 10], ["b.ts", 400], ["c.ts", 400], ["d.ts", 400]])
  const listed = formatParsedDiffWithTruncation(few, 200)
  assert.match(listed, /- b\.ts\n- c\.ts\n- d\.ts$/)

  // With many files the summary itself is budgeted, and the rest are counted rather than named.
  const many = {
    preface: "",
    files: Array.from({ length: 40 }, (_, index) => ({ fileName: `file-${index}.ts`, content: "x".repeat(20) })),
  }
  const counted = formatParsedDiffWithTruncation(many, 300)
  assert.match(counted, /more filenames \(paths not included for brevity\)/)
  assert.ok(counted.length <= 300)
})

// ---------------------------------------------------------------------------------------------
// attached git diffs
// ---------------------------------------------------------------------------------------------

test("an uncommitted diff and a branch diff are introduced differently", () => {
  const uncommitted = buildGitDiffUncommittedUserContent({ content: "+x\n", fullContentLengthCharCount: 4 })
  assert.match(uncommitted.text, /^<git_diff>/)
  assert.match(uncommitted.text, /<\/git_diff>$/)
  const branch = buildGitDiffUserContent({ content: "+x\n", fullContentLengthCharCount: 4 })
  assert.match(branch.text, /^<git_diff_from_branch_to_main>/)
})

test("a diff that arrived shortened says so, and one cut here says so once", () => {
  const shortened = buildGitDiffUserContent({ content: "+x\n", fullContentLengthCharCount: 100 })
  assert.equal(shortened.text.match(/diff truncated/g)?.length, 1)

  // A diff larger than the platform's own budget is cut here, and says so once.
  const content = `diff --git a/a.ts b/a.ts\n${"x".repeat(50_000)}`
  const large = buildGitDiffUserContent({ content, fullContentLengthCharCount: content.length })
  assert.equal(large.text.match(/diff truncated/g)?.length, 1)
  assert.ok(large.text.length < 41_000)
})

test("an empty diff renders as an empty block rather than nothing", () => {
  const empty = buildGitDiffUserContent({ fullContentLengthCharCount: 0 })
  assert.match(empty.text, /^<git_diff_from_branch_to_main>\n {2}Changes between this branch and the default branch:[\s\S]*\n {2}<\/git_diff_from_branch_to_main>$/)
})

// ---------------------------------------------------------------------------------------------
// the rules a turn is given
// ---------------------------------------------------------------------------------------------

function rule(overrides: Record<string, unknown> = {}): CursorRule {
  return new CursorRule({
    fullPath: "/p/.cursor/rules/a.mdc",
    content: "body",
    source: CursorRuleSource.UNSPECIFIED,
    ...overrides,
  } as never)
}

test("the workspace's rules and the server's are given together", () => {
  const rules = getAllRules({ rules: [rule()], disabledTeamRules: [] }, [rule({ fullPath: "/p/.cursor/rules/b.mdc" })])
  assert.equal(rules.length, 2)
})

test("a disabled team rule is dropped, and a required one cannot be disabled", () => {
  const teamRule = rule({ source: CursorRuleSource.TEAM, fullPath: "/p/.cursor/rules/team.mdc" })
  const requiredRule = rule({ source: CursorRuleSource.TEAM, fullPath: "/p/.cursor/rules/req.mdc", isRequired: true })
  const rules = getAllRules({ rules: [teamRule, requiredRule], disabledTeamRules: ["team.mdc", "req.mdc"] }, [])
  assert.deepEqual(rules.map(entry => entry.fullPath), ["/p/.cursor/rules/req.mdc"])
})

test("a team rule that arrives twice is given once, and a user's rule is never filtered", () => {
  const duplicated = rule({ source: CursorRuleSource.TEAM, fullPath: "/p/.cursor/rules/team.mdc" })
  const userRule = rule({ source: CursorRuleSource.USER, fullPath: "/p/.cursor/rules/user.mdc" })
  const rules = getAllRules(
    { rules: [duplicated, userRule], disabledTeamRules: ["user.mdc"] },
    [rule({ source: CursorRuleSource.TEAM, fullPath: "/other/team.mdc" })],
  )
  assert.equal(rules.filter(entry => entry.source === CursorRuleSource.TEAM).length, 1)
  assert.equal(rules.some(entry => entry.source === CursorRuleSource.USER), true)
})

test("a session told to drop the custom prompt context is given no rules", () => {
  assert.deepEqual(getAllRules({ rules: [rule()], disabledTeamRules: [] }, [rule()], { dropCustomPromptContext: true }), [])
})

// ---------------------------------------------------------------------------------------------
// the trigger information an automation's message carries
// ---------------------------------------------------------------------------------------------

test("the trigger block is read out of the message that carries it", () => {
  const text = extractAutomationTriggerContext([
    { role: "assistant", content: { unwrap: () => "ignored" } },
    {
      role: "user",
      content: [
        { type: "text", text: { unwrap: () => "before " } },
        { type: "text", text: { unwrap: () => "<automation_trigger_info>cron</automation_trigger_info> after" } },
      ],
    },
  ])
  assert.equal(text, "<automation_trigger_info>cron</automation_trigger_info>")
})

test("a message without a trigger block, and one that opens it but never closes it, yield nothing", () => {
  assert.equal(extractAutomationTriggerContext([{ role: "user", content: { unwrap: () => "hello" } }]), undefined)
  assert.equal(
    extractAutomationTriggerContext([{ role: "user", content: { unwrap: () => "<automation_trigger_info>cron" } }]),
    undefined,
  )
  assert.equal(extractAutomationTriggerContext([]), undefined)
})

// ---------------------------------------------------------------------------------------------
// rendering a directory tree
// ---------------------------------------------------------------------------------------------

function tree(overrides: Partial<SlateDirectoryTreeNode> = {}): SlateDirectoryTreeNode {
  return {
    absPath: "/p",
    childrenWereProcessed: true,
    numFiles: 2,
    fullSubtreeExtensionCounts: {},
    childrenFiles: [{ name: "a.ts" }],
    childrenDirs: [],
    ...overrides,
  }
}

test("a small tree is rendered in full", () => {
  const rendered = renderDirectoryTreeWithinBudget(tree())
  assert.match(rendered.result, /^\/p\/\n/)
  assert.match(rendered.result, /- a\.ts/)
})

test("a tree that does not fit is collapsed to counts before its depth is limited", () => {
  const manyFiles = Array.from({ length: 400 }, (_, index) => ({ name: `file-${index}.ts` }))
  const child = tree({
    absPath: "/p/sub",
    numFiles: 400,
    childrenFiles: manyFiles,
    fullSubtreeExtensionCounts: { ts: 400 },
  })
  const root = tree({ childrenFiles: [], childrenDirs: [child] })
  const rendered = renderDirectoryTreeWithinBudget(root, 500)
  assert.match(rendered.result, /in subtree: 400 \*ts/)
  assert.equal(rendered.atLeastOneExtensionCountRendered, true)
})

test("a directory whose subtree was not walked is shown with an ellipsis", () => {
  const unwalked = tree({ absPath: "/p/deep", childrenWereProcessed: false, numFiles: 0, childrenFiles: [] })
  const rendered = renderDirectoryTreeWithinBudget(tree({ childrenFiles: [], childrenDirs: [unwalked] }))
  assert.match(rendered.result, /- deep\/\.\.\./)
})

test("the separator follows the root's own path", () => {
  const backslash = String.fromCharCode(92)
  const windowsRoot = `C:${backslash}p`
  const windows = renderDirectoryTreeWithinBudget(tree({ absPath: windowsRoot }))
  assert.equal(windows.result.startsWith(`${windowsRoot}${backslash}`), true)
  assert.equal(windows.result.includes("  - a.ts"), true)
})

test("a terminal's history is shown with its commands", () => {
  const file = {
    name: "session",
    terminalMetadata: {
      cwd: "/p",
      lastModifiedMs: 1_700_000_000_000n,
      lastCommands: [{ command: "ls", exitCode: 0, timestampMs: 1_700_000_000_000n, durationMs: 12n }],
      currentCommand: { command: "sleep 100" },
    },
  }
  const rendered = renderDirectoryTreeWithinBudget(tree({ childrenFiles: [file] }))
  assert.match(rendered.result, /cwd: \/p/)
  assert.match(rendered.result, /last modified: 2023-11-14T22:13:20\.000Z/)
  assert.match(rendered.result, /last commands:/)
  assert.match(rendered.result, /- ls, exit: 0, time: 2023-11-14T22:13:20\.000Z, duration: 12ms/)
  assert.match(rendered.result, /current command:/)
  assert.match(rendered.result, /- sleep 100/)
})
