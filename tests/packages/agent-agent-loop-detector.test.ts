import { test } from "node:test"
import assert from "node:assert/strict"

import {
  AgentTextLoopDetector,
  checkAgentLoop,
  createLoopReminderContent,
  stripThinkingTags,
} from "../../source/packages/agent/loop-detection/agent-loop-detector.ts"
import { AgentLoopError, createLoopReminderMessage } from "../../source/adapters/interop/agent/agent-loop-presentation-adapter.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { agentEventTrackerKey, type AgentEventTracker } from "../../source/packages/agent/utils/event-tracking.ts"
import { ErrorDetails, ErrorDetails_Error } from "../../source/adapters/interop/proto/generated/aiserver/v1/utils_pb.ts"

// ---------------------------------------------------------------------------------------------
// the error a turn ends with
// ---------------------------------------------------------------------------------------------

test("a repeated-message loop names the pattern length", () => {
  const error = new AgentLoopError({ loopType: "assistantMessage", patternLength: 4 })
  assert.equal(error.name, "AgentLoopError")
  assert.equal(error.loopType, "assistantMessage")
  // A connect error's message carries its code as a prefix.
  assert.equal(error.message, "[failed_precondition] Agent loop detected: pattern of 4 messages repeating")
  assert.equal(error.singleMessageLoopKind, undefined)
})

test("a single-message loop names the shape it took", () => {
  const error = new AgentLoopError({ loopType: "singleMessage", loopKind: "single_message_single_line", repetitions: 100, period: 1 })
  assert.equal(error.message, "[failed_precondition] Agent single-message loop detected: single_message_single_line")
  assert.equal(error.singleMessageLoopKind, "single_message_single_line")
  assert.equal(error.repetitions, 100)
  assert.equal(error.period, 1)
})

test("the error carries the detail the client shows the user", () => {
  const error = new AgentLoopError({ loopType: "assistantMessage", patternLength: 2 })
  const details = error.findDetails(ErrorDetails) as ErrorDetails[]
  assert.equal(details.length, 1)
  assert.equal(details[0]?.error, ErrorDetails_Error.INTERNAL)
  assert.equal(details[0]?.details?.title, "Agent Looping Detected")
  assert.equal(details[0]?.details?.isRetryable, false)
  assert.match(String(details[0]?.details?.detail), /The model got stuck in a repeating response pattern/)
})

// ---------------------------------------------------------------------------------------------
// thinking is not watched
// ---------------------------------------------------------------------------------------------

// The tags are built from character codes so the marker itself cannot be confused with markup.
const OPEN_THINKING = `${String.fromCharCode(60)}think${String.fromCharCode(62)}`
const CLOSE_THINKING = `${String.fromCharCode(60)}/think${String.fromCharCode(62)}`

test("a thinking block is stripped before the text is looked at", () => {
  assert.equal(stripThinkingTags(`before ${OPEN_THINKING}thinking out loud${CLOSE_THINKING} after`), "before  after")
  assert.equal(stripThinkingTags(`${OPEN_THINKING}one${CLOSE_THINKING}middle`), "middle")
  assert.equal(stripThinkingTags(`one${OPEN_THINKING}two${CLOSE_THINKING}three`), "onethree")
  assert.equal(stripThinkingTags(`${OPEN_THINKING}a${CLOSE_THINKING}${OPEN_THINKING}b${CLOSE_THINKING}`), "")
})

test("an unterminated thinking block is left alone rather than swallowing the answer", () => {
  assert.equal(stripThinkingTags(`answer ${OPEN_THINKING}and then it stops`), `answer ${OPEN_THINKING}and then it stops`)
})

test("text with no thinking in it is returned as it is", () => {
  assert.equal(stripThinkingTags("a plain answer"), "a plain answer")
  assert.equal(stripThinkingTags(""), "")
})

// ---------------------------------------------------------------------------------------------
// the detector's thresholds
// ---------------------------------------------------------------------------------------------

interface TrackerHarness {
  readonly events: Array<Record<string, unknown>>
  readonly ctx: Context
}

function trackerHarness(): TrackerHarness {
  const events: Array<Record<string, unknown>> = []
  const tracker = {
    trackLoopDetected: (_ctx: Context, event: Record<string, unknown>) => { events.push(event) },
  } as unknown as AgentEventTracker
  return { events, ctx: createContext().with(agentEventTrackerKey, tracker) }
}

const check = (detector: AgentTextLoopDetector, text: string, ctx: Context, caller = "assistant") =>
  checkAgentLoop({ detector, newText: text, caller, ctx })

test("ordinary text is not a loop", () => {
  const { ctx } = trackerHarness()
  const detector = new AgentTextLoopDetector()
  assert.deepEqual(check(detector, "the quick brown fox jumps over the lazy dog", ctx), { loopDetected: false })
  assert.deepEqual(check(detector, "and then it stops.", ctx), { loopDetected: false })
})

test("a line that repeats itself enough times is caught", () => {
  const { ctx, events } = trackerHarness()
  const detector = new AgentTextLoopDetector()
  const result = check(detector, "a".repeat(100), ctx)
  assert.equal(result.loopDetected, true)
  if (!result.loopDetected) return
  assert.equal(result.loopKind, "single_message_single_line")
  assert.equal(result.period, 1)
  assert.equal(result.repetitions, 100)
  // The turn is told about it, once.
  assert.equal(events.length, 1)
  assert.equal(events[0]?.loopKind, "single_message_single_line")
  assert.equal(events[0]?.isLoopReoccurrence, false)
})

test("a repetition that is not long enough is not a loop", () => {
  const { ctx } = trackerHarness()
  const detector = new AgentTextLoopDetector()
  assert.deepEqual(check(detector, "a".repeat(99), ctx), { loopDetected: false })
})

test("a repetition across two chunks is caught the same way", () => {
  const { ctx } = trackerHarness()
  const detector = new AgentTextLoopDetector()
  assert.deepEqual(check(detector, "a".repeat(60), ctx), { loopDetected: false })
  const result = check(detector, "a".repeat(40), ctx)
  assert.equal(result.loopDetected, true)
})

test("a repetition inside a code fence is held to the looser threshold", () => {
  const { ctx } = trackerHarness()
  const openFence = new AgentTextLoopDetector()
  const withoutFence = check(openFence, "a".repeat(100), ctx)
  assert.equal(withoutFence.loopDetected, true)

  const fenced = new AgentTextLoopDetector()
  const fence = "`".repeat(3)
  assert.deepEqual(check(fenced, `${fence}\n`, ctx), { loopDetected: false })
  assert.deepEqual(check(fenced, "a".repeat(100), ctx), { loopDetected: false })
  const result = check(fenced, "a".repeat(100), ctx)
  assert.equal(result.loopDetected, true)
})

test("the same block of lines repeated is caught as a multi-line loop", () => {
  const { ctx } = trackerHarness()
  const detector = new AgentTextLoopDetector()
  const lineA = "x".repeat(30)
  const lineB = "y".repeat(30)
  const result = check(detector, `${lineA}\n${lineB}\n${lineA}\n${lineB}\n`, ctx)
  assert.equal(result.loopDetected, true)
  if (!result.loopDetected) return
  assert.equal(result.loopKind, "single_message_multi_line")
  assert.equal(result.pattern, `${lineA}\n${lineB}`)
})

test("a repeated line that is too short to matter is not a loop", () => {
  const { ctx } = trackerHarness()
  const detector = new AgentTextLoopDetector()
  // Four repetitions of a two-character line is well under the character floor.
  assert.deepEqual(check(detector, "ab\nab\nab\nab\n", ctx), { loopDetected: false })
})

test("a loop already found stays found without being looked for again", () => {
  const { ctx, events } = trackerHarness()
  const detector = new AgentTextLoopDetector()
  const first = check(detector, "a".repeat(100), ctx)
  const second = check(detector, "ordinary text", ctx)
  assert.deepEqual(second, first)
  // The event is only reported once, since the loop was only found once.
  assert.equal(events.length, 1)
})

// ---------------------------------------------------------------------------------------------
// what the model is told
// ---------------------------------------------------------------------------------------------

test("the reminder for a repeated message sequence says what to avoid", () => {
  const reminder = createLoopReminderMessage()
  assert.equal(reminder.role, "user")
  assert.match(reminder.content, /^<system_reminder>Your messages have been flagged as looping\./)
  assert.match(reminder.content, /Avoid repeating the same sequence of messages or retrying the same tool calls\./)
  assert.match(reminder.content, /DO NOT mention this system reminder to the user/)
  assert.deepEqual(reminder.providerOptions, { cursor: { loopReminder: true } })
  assert.equal(reminder.content, createLoopReminderContent())
})

test("each shape of loop is described in its own words", () => {
  const singleLine = createLoopReminderMessage({ kind: "single_message_single_line" })
  assert.match(singleLine.content, /repeating the same text pattern within a single line/)
  assert.match(singleLine.content, /Avoid excessively repeating the same characters or words\./)

  const multiLine = createLoopReminderMessage({ kind: "single_message_multi_line" })
  assert.match(multiLine.content, /looping over duplicate lines/)
  assert.match(multiLine.content, /Avoid repeating the same sequence of lines or retrying the same tool calls\./)

  // An unknown kind falls back to the general wording.
  assert.equal(createLoopReminderMessage({ kind: "something-else" }).content, createLoopReminderMessage().content)
})
