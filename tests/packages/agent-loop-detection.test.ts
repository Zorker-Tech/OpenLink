import { test } from "node:test"
import assert from "node:assert/strict"

import {
  StreamedTextLoopDetector,
  type StreamedTextLoopDetectorConfig,
} from "../../source/packages/agent/loop-detection/streamed-text-loop-detector.ts"

// ---------------------------------------------------------------------------------------------
// the detector watches text as it streams in
// ---------------------------------------------------------------------------------------------

/** No deadline by default, so a check either finds a loop or does not, and never runs out of time. */
function config(overrides: Partial<StreamedTextLoopDetectorConfig> = {}): StreamedTextLoopDetectorConfig {
  return {
    multiLineLoopMinRepetitions: () => 3,
    multiLineLoopMinRepetitionsInCodeFence: () => 5,
    maxLineLength: () => 100,
    maxCheckTimeMs: () => 0,
    singleLineLoopMinRepetitions: () => 3,
    singleLineLoopMinRepetitionsInCodeFence: () => 5,
    singleLineLoopMinPTimesK: () => 6,
    singleLineLoopMinPTimesKInCodeFence: () => 10,
    singleLineLoopMaxP: () => 4,
    multiLineLoopMinPTimesK: () => 3,
    multiLineLoopMinPTimesKInCodeFence: () => 5,
    multiLineLoopMinTotalChars: () => 6,
    multiLineLoopMinTotalCharsInCodeFence: () => 10,
    ...overrides,
  }
}

interface Recorded {
  readonly singleLine: Array<{ result: string; caller: string }>
  readonly multiLine: Array<{ result: string; caller: string }>
  readonly timeouts: Array<{ phase: string; caller: string }>
}

function hooksFor(recorded: Recorded): {
  onSingleLineCheck: (event: { latencyMs: number; result: string; caller: string }) => void
  onMultiLineCheck: (event: { latencyMs: number; result: string; caller: string }) => void
  onTimeout: (event: { latencyMs: number; phase: string; caller: string }) => void
} {
  return {
    onSingleLineCheck: event => recorded.singleLine.push({ result: event.result, caller: event.caller }),
    onMultiLineCheck: event => recorded.multiLine.push({ result: event.result, caller: event.caller }),
    onTimeout: event => recorded.timeouts.push({ phase: event.phase, caller: event.caller }),
  }
}

const emptyRecorded = (): Recorded => ({ singleLine: [], multiLine: [], timeouts: [] })

test("a detector starts with nothing found and nothing timed out", () => {
  const detector = new StreamedTextLoopDetector(config())
  assert.equal(detector.loopDetected(), false)
  assert.equal(detector.timedOut(), false)
  assert.equal(detector.getSingleLineLoopInfo(), null)
  assert.equal(detector.getMultiLineLoopInfo(), null)
})

test("a line of box drawing characters is not a repeated line", () => {
  const detector = new StreamedTextLoopDetector(config())
  assert.equal(detector.isBoxBorderLine("─────────"), true)
  assert.equal(detector.isBoxBorderLine("+----+----+"), true)
  assert.equal(detector.isBoxBorderLine("│ x │"), false)
  assert.equal(detector.isBoxBorderLine("   "), false)
  assert.equal(detector.isBoxBorderLine("plain text"), false)
})

test("four identical border lines are not a loop", () => {
  const detector = new StreamedTextLoopDetector(config())
  assert.equal(detector.addText({ newText: "-----\n-----\n-----\n-----\n", caller: "test" }), false)
  assert.equal(detector.loopDetected(), false)
})

// ---------------------------------------------------------------------------------------------
// one line repeating inside itself
// ---------------------------------------------------------------------------------------------

test("a line that repeats a short period is caught, with the period it repeats", () => {
  const recorded = emptyRecorded()
  const detector = new StreamedTextLoopDetector(config(), hooksFor(recorded))
  assert.equal(detector.addText({ newText: "ababab", caller: "assistant" }), true)
  assert.equal(detector.loopDetected(), true)
  assert.deepEqual(detector.getSingleLineLoopInfo(), { pattern: "ab", repetitions: 3, period: 2 })
  assert.deepEqual(recorded.singleLine.at(-1), { result: "loop_detected_single_line_substring", caller: "assistant" })
})

test("the repetition is found even when the text arrives in pieces", () => {
  const detector = new StreamedTextLoopDetector(config())
  assert.equal(detector.addText({ newText: "aba", caller: "test" }), false)
  assert.equal(detector.addText({ newText: "bab", caller: "test" }), true)
  assert.deepEqual(detector.getSingleLineLoopInfo(), { pattern: "ab", repetitions: 3, period: 2 })
})

test("ordinary prose is not a loop, and the check says so", () => {
  const recorded = emptyRecorded()
  const detector = new StreamedTextLoopDetector(config(), hooksFor(recorded))
  assert.equal(detector.addText({ newText: "the quick brown fox", caller: "test" }), false)
  assert.equal(detector.loopDetected(), false)
  assert.equal(recorded.singleLine.every(event => event.result === "no_loop_detected_single_line_substring"), true)
  assert.equal(recorded.singleLine.length > 0, true)
})

test("a repetition shorter than the threshold is not a loop", () => {
  // Two repetitions of a period are below the minimum of three.
  const detector = new StreamedTextLoopDetector(config())
  assert.equal(detector.addText({ newText: "abab", caller: "test" }), false)
})

test("a repetition whose period contains a space is still a repetition", () => {
  const detector = new StreamedTextLoopDetector(config())
  assert.equal(detector.addText({ newText: "a a a a a a a", caller: "test" }), true)
  // The period is "a " rather than "a", because the space is part of what repeats.
  assert.equal(detector.getSingleLineLoopInfo()?.period, 2)
  assert.equal(detector.getSingleLineLoopInfo()?.pattern.length, 2)
})

test("a period longer than the configured maximum is not looked for", () => {
  const detector = new StreamedTextLoopDetector(config({ singleLineLoopMaxP: () => 1 }))
  assert.equal(detector.addText({ newText: "ababab", caller: "test" }), false)
})

test("a line longer than the configured maximum is truncated rather than scanned whole", () => {
  const detector = new StreamedTextLoopDetector(config({ maxLineLength: () => 5 }))
  // All three lines are longer than the limit and differ past it, but only the kept part is compared.
  assert.equal(detector.addText({ newText: "hello world\nhello there\nhello again\n", caller: "test" }), true)
  assert.deepEqual(detector.getMultiLineLoopInfo()?.pattern, "hello")
})

// ---------------------------------------------------------------------------------------------
// whole lines repeating
// ---------------------------------------------------------------------------------------------

test("the same line repeated enough times is a loop", () => {
  const recorded = emptyRecorded()
  const detector = new StreamedTextLoopDetector(config(), hooksFor(recorded))
  assert.equal(detector.addText({ newText: "abc\nabc\nabc\n", caller: "test" }), true)
  assert.deepEqual(detector.getMultiLineLoopInfo(), { pattern: "abc", repetitions: 3 })
  assert.deepEqual(recorded.multiLine.at(-1), { result: "loop_detected", caller: "test" })
})

test("a repeated block of lines is caught with the block as its pattern", () => {
  const detector = new StreamedTextLoopDetector(config({
    multiLineLoopMinRepetitions: () => 2,
    multiLineLoopMinPTimesK: () => 4,
    multiLineLoopMinTotalChars: () => 4,
  }))
  assert.equal(detector.addText({ newText: "aa\nbb\naa\nbb\naa\nbb\n", caller: "test" }), true)
  assert.equal(detector.getMultiLineLoopInfo()?.pattern, "aa\nbb")
})

test("a block that repeats but is too short to matter is not reported", () => {
  const detector = new StreamedTextLoopDetector(config({ multiLineLoopMinTotalChars: () => 100 }))
  assert.equal(detector.addText({ newText: "abc\nabc\nabc\nabc\nabc\n", caller: "test" }), false)
  assert.equal(detector.loopDetected(), false)
})

test("lines inside a code fence are held to the looser threshold", () => {
  const outside = new StreamedTextLoopDetector(config())
  assert.equal(outside.addText({ newText: "abc\nabc\nabc\n", caller: "test" }), true)

  const inside = new StreamedTextLoopDetector(config())
  assert.equal(inside.addText({ newText: "```\nabc\nabc\nabc\n", caller: "test" }), false)
  assert.equal(inside.loopDetected(), false)
  // Five repetitions is what the fence threshold asks for.
  assert.equal(inside.addText({ newText: "abc\nabc\n", caller: "test" }), true)
})

test("a fence is only opened by a line with an odd number of markers", () => {
  const detector = new StreamedTextLoopDetector(config())
  // Two markers on the line do not change the fence state, so the ordinary threshold still applies.
  assert.equal(detector.addText({ newText: "x ``` y ``` z\nabc\nabc\nabc\n", caller: "test" }), true)
})

test("a single repetition is not enough for a multi-line loop", () => {
  const detector = new StreamedTextLoopDetector(config())
  assert.equal(detector.addText({ newText: "abc\nabc\n", caller: "test" }), false)
})

// ---------------------------------------------------------------------------------------------
// giving up, and starting over
// ---------------------------------------------------------------------------------------------

// A string with no repeated character at all, so a check over it can only ever run out of time.
const NON_REPEATING_TEXT = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$%^&*()_+-=[]{}"

test("a check that runs out of time says so instead of reporting no loop", () => {
  const recorded = emptyRecorded()
  const detector = new StreamedTextLoopDetector(
    config({ maxCheckTimeMs: () => 1, singleLineLoopMaxP: () => 40 }),
    hooksFor(recorded),
  )
  // A clock that always moves forward makes the deadline reachable without depending on machine load.
  const originalNow = performance.now
  let ticks = 0
  performance.now = () => { ticks += 1; return originalNow.call(performance) + ticks }
  try {
    assert.equal(detector.addText({ newText: NON_REPEATING_TEXT, caller: "test" }), false)
    assert.equal(detector.timedOut(), true)
    assert.equal(detector.loopDetected(), false)
    assert.equal(recorded.timeouts.length, 1)
    assert.equal(recorded.timeouts[0]?.phase, "single_line")
    assert.equal(recorded.timeouts[0]?.caller, "test")
  } finally {
    performance.now = originalNow
  }
})

test("once the check has given up nothing more is looked at", () => {
  const recorded = emptyRecorded()
  const detector = new StreamedTextLoopDetector(
    config({ maxCheckTimeMs: () => 1, singleLineLoopMaxP: () => 40 }),
    hooksFor(recorded),
  )
  const originalNow = performance.now
  let ticks = 0
  performance.now = () => { ticks += 1; return originalNow.call(performance) + ticks }
  try {
    detector.addText({ newText: NON_REPEATING_TEXT, caller: "test" })
    const after = recorded.singleLine.length
    assert.equal(detector.addText({ newText: "ababab", caller: "test" }), false)
    assert.equal(recorded.singleLine.length, after)
    assert.equal(detector.loopDetected(), false)
  } finally {
    performance.now = originalNow
  }
})

test("a detector can be reused after it is reset", () => {
  const detector = new StreamedTextLoopDetector(config())
  detector.addText({ newText: "abc\nabc\nabc\n", caller: "test" })
  assert.equal(detector.loopDetected(), true)

  detector.reset()
  assert.equal(detector.loopDetected(), false)
  assert.equal(detector.timedOut(), false)
  assert.equal(detector.getSingleLineLoopInfo(), null)
  assert.equal(detector.getMultiLineLoopInfo(), null)
  assert.equal(detector.lineCount, 0)
  assert.equal(detector.currentLine, "")

  // The lines from before are gone, so one repetition of the same line is not a loop again.
  assert.equal(detector.addText({ newText: "abc\nabc\n", caller: "test" }), false)
})
