import { test } from "node:test"
import assert from "node:assert/strict"

import { AGENTS_SECTION_ID, AGENTS_SECTION_NAME, SidebarSections } from "../../source/shared/sidebar-sections.ts"
import { SLATE_COMPUTER_UNAVAILABLE_MESSAGE, slateComputerUnavailableMessage, SLATE_NO_LOCAL_MACHINE_MESSAGE } from "../../source/shared/local-exec-gateway.ts"
import { LOG_SHIP_INTERVAL_MS, LOG_SHIP_JITTER_RATIO, nextLogShipDelayMs } from "../../source/shared/observability/log-ship-cadence.ts"
import { formatUtcOffset, isValidIanaTimeZone, renderTimeZoneSystemPrompt } from "../../source/shared/timezone.ts"
import { parseHeapMetricsReport } from "../../source/shared/observability/heap-metrics.ts"
import { isDevControlsMethod, DEV_CONTROLS_METHOD_TABLE } from "../../source/shared/rpc/dev-controls.ts"
import {
  mainTranscriptOf,
  threadOf,
  isPeerMessage,
  isHiddenOutboundPeerMessage,
  settledAutoReviewEntry,
  settledToolPermissionEntry,
  SLATE_REACTION_AGENT,
  SLATE_REACTION_SELF,
} from "../../source/shared/transcript.ts"
import {
  getBoxNamespace,
  getSlateClientBaseVersion,
  getSlateClientVersion,
  SLATE_BOX_NAMESPACE_HEADER,
  SLATE_CLIENT_TYPE,
} from "../../source/shared/node/slate-client-metadata.ts"
import { SLATE_NO_WEBAUTHN_MACHINE_MESSAGE } from "../../source/shared/webauthn-gateway.ts"
import {
  encodeBoxBlockedMessage,
  findBoxBlockedMessage,
  hasBoxBlockedMarker,
  GATEWAY_NO_STORAGE_MESSAGE_MARKER,
  SLATE_BOX_BLOCKED,
  SLATE_BOX_BLOCK_REASON_KEY,
} from "../../source/shared/gateway-reachability.ts"
import { getFilePreviewKind, previewKindNeedsBytes } from "../../source/shared/media/file-preview-kind.ts"
import { formatAttachmentSentSummary, kindPhrase, mergeKindCounts } from "../../source/shared/media/attachments.ts"

// ---------------------------------------------------------------------------------------------
// What a surface groups and shows
// ---------------------------------------------------------------------------------------------

test("sections are normalized before they are shown", () => {
  const normalized = SidebarSections.normalize([
    { id: "work", name: "Work", agentIds: ["a", "b"] },
    { id: "work", name: "Work again", agentIds: ["c"] },
    { id: "  ", name: "Nothing", agentIds: ["d"] },
    { id: AGENTS_SECTION_ID, name: AGENTS_SECTION_NAME, agentIds: ["e"] },
    { id: "other", name: "Other", agentIds: ["a", "f", ""] },
  ])
  // The second section with the same id, the one with no id, and the unassigned section are all gone, and an
  // agent belongs to the first section that claims it.
  // The unassigned section is kept as a section, but it claims no agents of its own.
  assert.deepEqual(normalized, [
    { id: "work", name: "Work", agentIds: ["a", "b"] },
    { id: "other", name: "Other", agentIds: ["f"] },
    { id: AGENTS_SECTION_ID, name: AGENTS_SECTION_NAME, agentIds: [] },
  ])
  // Folds are carried from what was stored, and the sections are read back from what a client persisted.
  const folded = SidebarSections.withFolds(normalized, ["other"])
  assert.deepEqual(folded.map(section => section.isCollapsed), [false, true, false])
  assert.deepEqual(SidebarSections.parse(normalized as unknown[]).length, 3)
  assert.deepEqual(SidebarSections.carryFolds({ sections: normalized, stored: folded }).map(section => section.isCollapsed), [false, true, false])
})

test("the message about a machine that is not there names the computer when it can", () => {
  assert.match(SLATE_NO_LOCAL_MACHINE_MESSAGE, /Slate desktop app/)
  assert.match(SLATE_COMPUTER_UNAVAILABLE_MESSAGE, /Your computer is unavailable/)
  assert.match(slateComputerUnavailableMessage("my laptop"), /"my laptop"/)
  assert.equal(slateComputerUnavailableMessage(""), SLATE_COMPUTER_UNAVAILABLE_MESSAGE)
  assert.match(SLATE_NO_WEBAUTHN_MACHINE_MESSAGE, /Open Slate on the machine/)
})

test("an attachment's kind is said in words, singular or plural", () => {
  assert.equal(kindPhrase("image", 1), "1 image")
  assert.equal(kindPhrase("image", 2), "2 images")
  assert.equal(kindPhrase("pdf", 3), "3 PDFs")
  assert.equal(kindPhrase("file", 2), "2 files")
  // Counts are merged by kind, and what was sent is summarized for the user.
  const merged = mergeKindCounts([{ kind: "image", count: 1 }, { kind: "image", count: 2 }, { kind: "nonsense", count: 5 }])
  // A kind the platform does not know is counted as a file rather than dropped.
  assert.deepEqual(merged, [{ kind: "image", count: 3 }, { kind: "file", count: 5 }])
  assert.equal(mergeKindCounts(undefined).length, 0)
  assert.match(formatAttachmentSentSummary(1), /1/)
  assert.match(formatAttachmentSentSummary(3, [{ kind: "image", count: 3 }]), /3 images/)
})

test("a file's preview kind follows what it is", () => {
  assert.equal(getFilePreviewKind("photo.png"), "image")
  assert.equal(getFilePreviewKind("clip.mp4"), "video")
  assert.equal(getFilePreviewKind("notes.md"), "markdown")
  assert.equal(getFilePreviewKind("data.json"), "json")
  assert.equal(getFilePreviewKind("sheet.csv"), "table")
  assert.equal(getFilePreviewKind("report.pdf"), "pdf")
  assert.equal(getFilePreviewKind("mystery.xyzzy"), "unknown")
  // Only the kinds that have to be sniffed are read as bytes.
  assert.equal(previewKindNeedsBytes("text"), true)
  assert.equal(previewKindNeedsBytes("image"), false)
})

// ---------------------------------------------------------------------------------------------
// Transcripts and approvals
// ---------------------------------------------------------------------------------------------

test("an approval a surface is still showing is settled, and nothing else is", () => {
  const pending = { kind: "send-message", message: { type: "auto-review-approval", approval: { requestId: "r1", status: "pending" } } }
  const settled = settledAutoReviewEntry(pending, "approved")
  assert.equal(settled?.message?.approval?.status, "approved")
  // A request that is not the one named, an entry that is not pending, and an entry of another kind are left alone.
  assert.equal(settledAutoReviewEntry(pending, "approved", "other"), null)
  assert.equal(settledAutoReviewEntry({ ...pending, message: { ...pending.message, approval: { requestId: "r1", status: "approved" } } }, "approved"), null)
  assert.equal(settledAutoReviewEntry({ kind: "message", message: pending.message }, "approved"), null)

  const ask = { kind: "send-message", message: { type: "local-tool-permission", ask: { requestId: "r2", status: "pending" } } }
  assert.equal(settledToolPermissionEntry(ask, "denied")?.message?.ask?.status, "denied")
  assert.equal(settledToolPermissionEntry(pending, "denied"), null)
})

test("a transcript's main and threaded entries are told apart", () => {
  const entries = [
    { kind: "message", id: "1" },
    { kind: "message", id: "2", replyTo: "1" },
    { kind: "message", id: "3", branched: true },
    { kind: "message", id: "4", branched: true, replyTo: "1" },
  ]
  // A branched entry that replies into a thread is the thread's; one that stands on its own — and one that
  // replies without being a branch — is still the main transcript's.
  assert.deepEqual(mainTranscriptOf(entries).map(entry => entry.id), ["1", "2", "3"])
  assert.deepEqual(threadOf(entries, "1").map(entry => entry.id), ["1", "4"])
  assert.deepEqual(threadOf(entries, "nope"), [])

  // A message between agents is not the user's activity, and one the user should not see is hidden.
  assert.equal(isPeerMessage({ kind: "message", fromAgent: { id: "a" } }), true)
  assert.equal(isPeerMessage({ kind: "message" }), false)
  assert.equal(isHiddenOutboundPeerMessage({ kind: "message", toAgent: { kind: "user" } }), true)
  assert.equal(isHiddenOutboundPeerMessage({ kind: "message", toAgent: { kind: "agent" } }), false)
  assert.equal(SLATE_REACTION_SELF, "me")
  assert.equal(SLATE_REACTION_AGENT, "agent")
})

// ---------------------------------------------------------------------------------------------
// The client, the gateway and the logs
// ---------------------------------------------------------------------------------------------

test("the client says which build it is and which box it belongs to", () => {
  assert.equal(SLATE_CLIENT_TYPE, "slate")
  assert.equal(SLATE_BOX_NAMESPACE_HEADER, "x-slate-box-namespace")
  assert.equal(getSlateClientBaseVersion({ SLATE_CLIENT_APP_VERSION: "1.2.3" } as NodeJS.ProcessEnv), "1.2.3")
  assert.equal(getSlateClientBaseVersion({ SLATE_CLIENT_APP_VERSION: "1.2.3-dev.4" } as NodeJS.ProcessEnv), "1.2.3")
  assert.equal(getSlateClientBaseVersion({} as NodeJS.ProcessEnv).length > 0, true)

  // The namespace comes from the environment when it names one, and from the build's variant otherwise.
  assert.equal(getBoxNamespace({ SLATE_BOX_OWNER_NAMESPACE: "lab" } as NodeJS.ProcessEnv), "lab")
  const namespace = getBoxNamespace({} as NodeJS.ProcessEnv)
  assert.equal(["dev", "lab", "prod"].includes(namespace), true)
  assert.equal(getSlateClientVersion({ SLATE_CLIENT_APP_VERSION: "1.2.3" } as NodeJS.ProcessEnv).startsWith("1.2.3"), true)
})

test("a box that is blocked says why, and the reason is read back", () => {
  const message = encodeBoxBlockedMessage({ reason: "SLATE_CLIENT_PAUSE", title: "Paused", detail: "Resume it" })
  assert.equal(hasBoxBlockedMarker(message), true)
  assert.equal(findBoxBlockedMessage(new Error(message)), message)
  assert.equal(findBoxBlockedMessage(new Error("something else")), null)
  assert.equal(hasBoxBlockedMarker("something else"), false)
  assert.equal(SLATE_BOX_BLOCKED, "SLATE_BOX_BLOCKED")
  assert.equal(SLATE_BOX_BLOCK_REASON_KEY, "slateBoxBlockReason")
  // The markers the platform looks for are its own.
  assert.equal(GATEWAY_NO_STORAGE_MESSAGE_MARKER.startsWith("slate "), true)
})

test("how long to wait before shipping logs again", () => {
  const noJitter = () => 0
  assert.equal(nextLogShipDelayMs({ outcome: "shipped", streak: 0, random: noJitter }), LOG_SHIP_INTERVAL_MS)
  // A failure backs off, doubling with each attempt in a row.
  const first = nextLogShipDelayMs({ outcome: "failed", streak: 0, random: noJitter })
  const second = nextLogShipDelayMs({ outcome: "failed", streak: 1, random: noJitter })
  assert.equal(second, first * 2)
  assert.equal(nextLogShipDelayMs({ outcome: "failed", streak: 40, random: noJitter }), 60_000)
  // A rate limit waits at least as long as the service asked for.
  // The service's own answer wins when it is longer than the backoff would have been.
  assert.equal(nextLogShipDelayMs({ outcome: "rate_limited", streak: 0, retryAfterMs: 10 * 60_000, random: noJitter }), 10 * 60_000)
  assert.equal(nextLogShipDelayMs({ outcome: "rate_limited", streak: 40, retryAfterMs: 0, random: noJitter }), 5 * 60_000)
  assert.equal(nextLogShipDelayMs({ outcome: "rate_limited", streak: 0, retryAfterMs: 60_000, random: noJitter }), 60_000)
  // A quarter of the delay is added at random, so a fleet does not come back at once.
  const jittered = nextLogShipDelayMs({ outcome: "shipped", streak: 0, random: () => 1 })
  assert.equal(jittered, Math.round(LOG_SHIP_INTERVAL_MS * (1 + LOG_SHIP_JITTER_RATIO)))
})

test("a time zone is checked, and said the way a user reads it", () => {
  assert.equal(isValidIanaTimeZone("America/Los_Angeles"), true)
  assert.equal(isValidIanaTimeZone("UTC"), true)
  assert.equal(isValidIanaTimeZone(""), false)
  assert.equal(isValidIanaTimeZone("Not/AZone"), false)

  const now = new Date("2026-01-15T12:00:00Z")
  assert.equal(formatUtcOffset(now, "UTC"), "UTC+0")
  assert.equal(formatUtcOffset(now, "America/Los_Angeles"), "UTC-8")
  assert.equal(formatUtcOffset(now, "Not/AZone"), null)

  assert.equal(renderTimeZoneSystemPrompt(undefined), "")
  const prompt = renderTimeZoneSystemPrompt("America/Los_Angeles", now)
  assert.match(prompt, /## Time/)
  assert.match(prompt, /America\/Los_Angeles/)
})

test("a memory report is read only when it matches its shape", () => {
  const report = parseHeapMetricsReport({ usedBytes: 100, limitBytes: 1_000, loadedAgents: 2 })
  assert.equal(report?.usedBytes, 100)
  assert.equal(report?.loadedAgents, 2)
  // A report that is missing what it must have, or that counts something that is not a count, is not one.
  assert.equal(parseHeapMetricsReport({ usedBytes: 100 }), null)
  // A count that is not a count is dropped, and the report keeps what it does have.
  assert.deepEqual(parseHeapMetricsReport({ usedBytes: 100, limitBytes: 1_000, loadedAgents: -1 }), { usedBytes: 100, limitBytes: 1_000 })
  assert.equal(parseHeapMetricsReport(null), null)
})

test("the development controls answer the methods they declare", () => {
  assert.equal(isDevControlsMethod("restartElectron"), true)
  assert.equal(isDevControlsMethod("toString"), false)
  assert.equal(Object.keys(DEV_CONTROLS_METHOD_TABLE).includes("setThemePreference"), true)
})
