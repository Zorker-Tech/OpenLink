import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { SLATE_BOX_READ_TOOL_NAME, SLATE_BOX_SHELL_TOOL_NAME, SLATE_DEFAULT_EXTERNAL_MACHINE_ID, SLATE_EXTERNAL_MACHINES, SLATE_EXTERNAL_SHELL_TOOL_NAME, resolveSlateExternalMachine } from "../../source/shared/agents/agent-tool-names.ts"
import { EMPTY_SLATE_SHARING_STATE, formatRemoteAgentId, isPublishableShareAvatarDataUrl, isRemoteAgentId, parseRemoteAgentId, REMOTE_AGENT_ID_PREFIX, SLATE_SHARE_AVATAR_DATA_URL_MAX_LENGTH } from "../../source/shared/agents/sharing.ts"
import { replyCountByBranch, branchEntries } from "../../source/shared/transcript-threads.ts"
import { filePathFromFileUrl, isPathWithin } from "../../source/shared/node/paths.ts"
import { parseTraceparent, SEND_TRACE_SAMPLE_RATIO } from "../../source/shared/observability/send-trace.ts"
import { getWidgetAnswerLabel, slateWidgetSchema, summarizeWidget } from "../../source/shared/slate-widgets.ts"
import { ACTION_VERB } from "../../source/shared/slate-timeline-events.ts"
import { EGRESS_TUNNEL_WS_PORT } from "../../source/shared/node/egress-tunnel/box-connection.ts"

// ---------------------------------------------------------------------------------------------
// The names the platform's own tools are known by
// ---------------------------------------------------------------------------------------------

test("the tools that act on a machine are named for the machine they act on", () => {
  assert.equal(SLATE_BOX_SHELL_TOOL_NAME, "Shell")
  assert.equal(SLATE_BOX_READ_TOOL_NAME, "Read")
  assert.equal(SLATE_EXTERNAL_SHELL_TOOL_NAME, "ExternalShell")
  assert.equal(SLATE_DEFAULT_EXTERNAL_MACHINE_ID, "user-computer")
  assert.equal((SLATE_EXTERNAL_MACHINES[SLATE_DEFAULT_EXTERNAL_MACHINE_ID]?.label.length ?? 0) > 0, true)

  // A machine the platform knows is resolved by its id, and anything else is the user's own computer.
  const known = resolveSlateExternalMachine(SLATE_DEFAULT_EXTERNAL_MACHINE_ID)
  assert.equal(known?.id, SLATE_DEFAULT_EXTERNAL_MACHINE_ID)
  // A machine the platform does not know is not invented.
  assert.equal(resolveSlateExternalMachine("some-machine"), undefined)
  assert.equal(EGRESS_TUNNEL_WS_PORT, 8790)
})

// ---------------------------------------------------------------------------------------------
// Agents that belong to somebody else
// ---------------------------------------------------------------------------------------------

test("a shared agent's id carries its owner as well as itself", () => {
  const reference = { ownerAuthId: "owner 1", agentId: "agent/1" }
  const id = formatRemoteAgentId(reference)
  assert.equal(id.startsWith(REMOTE_AGENT_ID_PREFIX), true)
  // The parts are escaped, so an id with a slash in it does not split into more parts.
  assert.equal(id, `${REMOTE_AGENT_ID_PREFIX}owner%201/agent%2F1`)
  assert.deepEqual(parseRemoteAgentId(id), reference)
  assert.equal(isRemoteAgentId(id), true)
  assert.equal(isRemoteAgentId("agent-1"), false)
  assert.equal(parseRemoteAgentId("agent-1"), null)
  assert.equal(parseRemoteAgentId(`${REMOTE_AGENT_ID_PREFIX}only-one-part`), null)
})

test("an avatar is published only when it is a data url the platform will accept", () => {
  const image = `data:image/png;base64,${"a".repeat(100)}`
  assert.equal(isPublishableShareAvatarDataUrl(image), true)
  assert.equal(isPublishableShareAvatarDataUrl("https://example.com/a.png"), false)
  assert.equal(isPublishableShareAvatarDataUrl(`data:image/png;base64,${"a".repeat(SLATE_SHARE_AVATAR_DATA_URL_MAX_LENGTH)}`), false)
  // Sharing starts off, with nothing pending and nobody in a room.
  assert.equal(EMPTY_SLATE_SHARING_STATE.isEnabled, false)
  assert.equal(EMPTY_SLATE_SHARING_STATE.rooms.length, 0)
  assert.equal(EMPTY_SLATE_SHARING_STATE.selfAuthId, null)
})

// ---------------------------------------------------------------------------------------------
// Threads and paths
// ---------------------------------------------------------------------------------------------

test("a thread's descendants and reply counts are read from the replies", () => {
  // A branch hangs off a main-transcript entry: the root is the first ancestor that is not itself branched.
  const entries = [
    { id: "root" },
    { id: "a", replyTo: "root", branched: true },
    { id: "b", replyTo: "a", branched: true },
    { id: "c", replyTo: "root", branched: true },
    { id: "d" },
  ]
  // What is passed is the branch's own entries — the root it hangs off is not among them — and a reply to a
  // reply is found through the root it hangs off.
  const branch = entries.filter(entry => entry.branched === true)
  assert.deepEqual(branchEntries("root", branch).map(entry => entry.id), ["a", "b", "c"])
  // The counts are per branch root: every reply in a branch counts towards the entry it hangs off.
  const counts = replyCountByBranch(branch)
  assert.equal(counts.get("root"), 3)
  assert.equal(counts.get("a"), undefined)
  assert.equal(counts.get("d"), undefined)
  // A reply whose parent is not among the branch's entries hangs off that parent, which is how a branch that
  // starts in the middle of a thread is read.
  assert.deepEqual(branchEntries("missing", [{ id: "x", replyTo: "missing" }]).map(entry => entry.id), ["x"])
  // An entry that replies to nothing is not in a branch: it is neither counted nor given a root of its own.
  assert.deepEqual([...replyCountByBranch([{ id: "alone" }])], [])
  assert.deepEqual(branchEntries("alone", [{ id: "alone" }]), [])
  // A cycle has no root at all rather than being walked forever.
  const cyclic = [{ id: "p", replyTo: "q", branched: true }, { id: "q", replyTo: "p", branched: true }]
  assert.deepEqual(branchEntries("p", cyclic), [])
  assert.deepEqual(branchEntries("q", cyclic), [])
})

test("a path is compared as a path rather than as a string", () => {
  assert.equal(isPathWithin("/repo", "/repo/src/a.ts"), true)
  assert.equal(isPathWithin("/repo", "/repo"), false)
  assert.equal(isPathWithin("/repo", "/repo", { isInclusive: true }), true)
  assert.equal(isPathWithin("/repo", "/repository/a.ts"), false)
  // A path that steps up is resolved before it is compared, so it cannot pretend to be inside.
  assert.equal(isPathWithin("/repo", "/repo/../elsewhere/a.ts"), false)
  assert.equal(isPathWithin("/repo", "/repo/src/../a.ts"), true)
  // A path that is not absolute is not inside anything, since it could be anywhere.
  assert.equal(isPathWithin("/repo", "src/a.ts"), false)
})

test("a file url is turned back into a path", () => {
  const url = pathToFileURL("/tmp/a b.txt").toString()
  assert.equal(filePathFromFileUrl(url), path.join("/tmp", "a b.txt"))
  assert.equal(filePathFromFileUrl("https://example.com/a"), null)
  assert.equal(filePathFromFileUrl("not a url"), null)
})

// ---------------------------------------------------------------------------------------------
// Traces and widgets
// ---------------------------------------------------------------------------------------------

test("a trace context is checked before it is used", () => {
  const traceId = "a".repeat(32)
  const spanId = "b".repeat(16)
  const parsed = parseTraceparent(`00-${traceId}-${spanId}-01`)
  assert.equal(parsed?.traceId, traceId)
  assert.equal(parsed?.spanId, spanId)
  assert.equal(parsed?.traceFlags, 1)
  assert.equal(SEND_TRACE_SAMPLE_RATIO, 1)

  // A header that is the wrong shape, or that carries the all-zero ids the standard calls invalid, is refused.
  assert.equal(parseTraceparent("not a traceparent"), undefined)
  assert.equal(parseTraceparent(`00-${"0".repeat(32)}-${spanId}-01`), undefined)
  assert.equal(parseTraceparent(`00-${traceId}-${"0".repeat(16)}-01`), undefined)
  assert.equal(parseTraceparent(`00-${traceId}-${spanId}`), undefined)
  assert.equal(parseTraceparent(`01-${traceId}-${spanId}-01`), undefined)
  assert.equal(parseTraceparent(""), undefined)
  assert.equal(parseTraceparent(undefined), undefined)
})

test("a choice widget is read against the schema it is rendered from", () => {
  const parsed = slateWidgetSchema.parse({
    prompt: "Which one?",
    options: [{ label: "First", value: "first" }, { label: "Second", style: "primary" }],
  })
  assert.equal(parsed.options.length, 2)
  assert.equal(parsed.options[0]?.label, "First")
  // A widget with no options, with an option that says nothing, or with no question, is refused.
  assert.throws(() => slateWidgetSchema.parse({ prompt: "Which one?", options: [] }))
  assert.throws(() => slateWidgetSchema.parse({ prompt: "Which one?", options: [{ label: "  " }] }))
  assert.throws(() => slateWidgetSchema.parse({ options: [{ label: "First" }] }))

  // A widget is summarized by its question and its labels, and an answer is shown by its label.
  assert.equal(summarizeWidget(parsed), "Which one? — First / Second")
  assert.equal(getWidgetAnswerLabel(parsed, "first"), "First")
  assert.equal(getWidgetAnswerLabel(parsed, "something else"), "something else")
})

test("the timeline says what an automation did in words", () => {
  assert.equal(ACTION_VERB.created, "Created")
  assert.equal(ACTION_VERB.deleted, "Deleted")
  assert.equal(Object.keys(ACTION_VERB).length, 5)
})
