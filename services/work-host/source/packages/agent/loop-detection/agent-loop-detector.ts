/**
 * Catching a model that has got stuck, and saying so in a way the turn can act on.
 *
 * Two shapes of stuck are watched for. One message can repeat itself — the same characters over and over,
 * or the same lines — and that is caught as the text streams, by a detector configured with this agent's
 * thresholds, which are deliberately loose: a repeated line in a code sample is often deliberate, so the
 * repetition has to be long before it counts. Across messages, the turn itself can repeat, and that is
 * detected elsewhere and reported here in the same shape.
 *
 * The detector is given a deadline and fails open: if checking the text takes too long, the turn is not
 * stopped, because a slow check is not evidence of a loop. A loop that is found becomes an error the turn
 * ends with — carrying the detail the client shows, so the user is told the model got stuck rather than
 * being left with a turn that stops for no reason — and a reminder the conversation can be given, which
 * says what was wrong and asks the model not to mention the reminder itself.
 *
 * Thinking tags are stripped before the text is looked at, because a model that is thinking in a loop has
 * not necessarily got stuck in its answer, and the repetition inside a chain of thought is not the thing
 * being watched for.
 */

import { createLogger } from "../../context/index.ts"
import { createCounter, createHistogram } from "../../metrics/index.ts"
import { getAgentEventTracker } from "../utils/event-tracking.ts"
import { StreamedTextLoopDetector as BaseTextLoopDetector } from "./streamed-text-loop-detector.ts"

const logger = createLogger("@slate/agent:loop-detection")
const loopDetectionCounter = createCounter("agent.assistant_message_looping", {
  description: "Count of agent message loops detected",
  labelNames: ["loop_kind", "isLoopReoccurrence", "caller"],
})
const loopDetectionLatency = createHistogram("agent.assistant_message_looping.latency_ms", {
  description: "Latency of loop detection in milliseconds",
  labelNames: ["result", "caller"],
})
const singleMessageLoopCheckLatency = createHistogram("agent.single_message_looping.check_for_loop.latency_ms", {
  description: "Latency of single-message loop detector checks in milliseconds",
  labelNames: ["result", "caller"],
})

// The thresholds a single message is held to. They are looser inside a code fence, where a repeated line
// is more often deliberate than accidental.
const SINGLE_MESSAGE_MULTI_LINE_LOOP_MIN_REPETITIONS = 2
const SINGLE_MESSAGE_MULTI_LINE_LOOP_MIN_REPETITIONS_IN_CODE_FENCE = 3
const SINGLE_MESSAGE_LOOP_DETECTOR_MAX_LINE_LENGTH = 10_000
const SINGLE_LINE_LOOP_MIN_REPETITIONS = 3
const SINGLE_LINE_LOOP_MIN_REPETITIONS_IN_CODE_FENCE = 4
const SINGLE_LINE_LOOP_MIN_P_TIMES_K = 100
const SINGLE_LINE_LOOP_MIN_P_TIMES_K_IN_CODE_FENCE = 200
const SINGLE_LINE_LOOP_MAX_P = 256
const SINGLE_MESSAGE_MULTI_LINE_LOOP_MIN_P_TIMES_K = 3
const SINGLE_MESSAGE_MULTI_LINE_LOOP_MIN_P_TIMES_K_IN_CODE_FENCE = 4
const MULTI_LINE_LOOP_MIN_TOTAL_CHARS = 50
const MULTI_LINE_LOOP_MIN_TOTAL_CHARS_IN_CODE_FENCE = 100
const SINGLE_MESSAGE_LOOP_DETECTOR_MAX_CHECK_TIME_MS = 500

export type AgentLoopErrorOptions =
  | { loopType: "assistantMessage"; patternLength: number }
  | { loopType: "singleMessage"; loopKind: string; repetitions: number; period?: number | undefined }

/** A model thinking in a loop has not necessarily got stuck in its answer, so thinking is not watched. */
export function stripThinkingTags(text: string): string {
  let startIndex = text.indexOf("<think>")
  while (startIndex !== -1) {
    const endIndex = text.indexOf("</think>", startIndex)
    if (endIndex === -1) break
    text = text.slice(0, startIndex) + text.slice(endIndex + "</think>".length)
    startIndex = text.indexOf("<think>", startIndex)
  }
  return text
}

export class AgentTextLoopDetector extends BaseTextLoopDetector {
  constructor() {
    super({
      multiLineLoopMinRepetitions: () => SINGLE_MESSAGE_MULTI_LINE_LOOP_MIN_REPETITIONS,
      multiLineLoopMinRepetitionsInCodeFence: () => SINGLE_MESSAGE_MULTI_LINE_LOOP_MIN_REPETITIONS_IN_CODE_FENCE,
      maxLineLength: () => SINGLE_MESSAGE_LOOP_DETECTOR_MAX_LINE_LENGTH,
      maxCheckTimeMs: () => SINGLE_MESSAGE_LOOP_DETECTOR_MAX_CHECK_TIME_MS,
      singleLineLoopMinRepetitions: () => SINGLE_LINE_LOOP_MIN_REPETITIONS,
      singleLineLoopMinRepetitionsInCodeFence: () => SINGLE_LINE_LOOP_MIN_REPETITIONS_IN_CODE_FENCE,
      singleLineLoopMinPTimesK: () => SINGLE_LINE_LOOP_MIN_P_TIMES_K,
      singleLineLoopMinPTimesKInCodeFence: () => SINGLE_LINE_LOOP_MIN_P_TIMES_K_IN_CODE_FENCE,
      singleLineLoopMaxP: () => SINGLE_LINE_LOOP_MAX_P,
      multiLineLoopMinPTimesK: () => SINGLE_MESSAGE_MULTI_LINE_LOOP_MIN_P_TIMES_K,
      multiLineLoopMinPTimesKInCodeFence: () => SINGLE_MESSAGE_MULTI_LINE_LOOP_MIN_P_TIMES_K_IN_CODE_FENCE,
      multiLineLoopMinTotalChars: () => MULTI_LINE_LOOP_MIN_TOTAL_CHARS,
      multiLineLoopMinTotalCharsInCodeFence: () => MULTI_LINE_LOOP_MIN_TOTAL_CHARS_IN_CODE_FENCE,
    })
  }
}

/** Which shape of repetition was found, named so the two are counted apart. */
function getAgentLoopInfo(detector: AgentTextLoopDetector) {
  const singleLoopInfo = detector.getSingleLineLoopInfo()
  const multiLineLoopInfo = detector.getMultiLineLoopInfo()
  const loopInfo = singleLoopInfo ?? multiLineLoopInfo
  if (!loopInfo) return null
  return {
    loopKind: singleLoopInfo ? "single_message_single_line" : "single_message_multi_line",
    pattern: loopInfo.pattern,
    repetitions: loopInfo.repetitions,
    period: singleLoopInfo?.period,
  }
}

interface CheckLoopParams {
  readonly detector: AgentTextLoopDetector
  readonly newText: string
  readonly caller: string
  readonly ctx: Parameters<typeof getAgentEventTracker>[0]
}

export function checkAgentLoop(params: CheckLoopParams) {
  // A loop already found stays found, so the answer does not depend on when the check is made.
  if (params.detector.loopDetected()) {
    const loopInfo = getAgentLoopInfo(params.detector)
    if (!loopInfo) return { loopDetected: false as const }
    return { loopDetected: true as const, ...loopInfo }
  }
  if (params.detector.timedOut()) return { loopDetected: false as const }
  const addTextStartTime = performance.now()
  const loopDetected = params.detector.addText({ newText: params.newText, caller: params.caller })
  const addTextLatencyMs = performance.now() - addTextStartTime
  // A check that ran out of time fails open: being slow is not evidence of a loop.
  if (!loopDetected && params.detector.timedOut()) {
    singleMessageLoopCheckLatency.histogram(params.ctx, addTextLatencyMs, { result: "timeout", caller: params.caller })
    logger.info(params.ctx, "NAL single-message loop detection timed out; failing open", { caller: params.caller, newTextLength: params.newText.length })
    return { loopDetected: false as const }
  }
  if (!loopDetected) {
    singleMessageLoopCheckLatency.histogram(params.ctx, addTextLatencyMs, { result: "no_loop_detected", caller: params.caller })
    return { loopDetected: false as const }
  }
  const loopInfo = getAgentLoopInfo(params.detector)
  if (!loopInfo) {
    singleMessageLoopCheckLatency.histogram(params.ctx, addTextLatencyMs, { result: "no_loop_detected", caller: params.caller })
    return { loopDetected: false as const }
  }
  singleMessageLoopCheckLatency.histogram(params.ctx, addTextLatencyMs, { result: "loop_detected", caller: params.caller })
  logger.warn(params.ctx, "NAL single-message looping detected", {
    loopKind: loopInfo.loopKind,
    repetitions: loopInfo.repetitions,
    period: loopInfo.period,
    // The whole repetition is not logged; enough of it to recognize is.
    patternPreview: `${loopInfo.pattern.slice(0, 200)}${loopInfo.pattern.length > 200 ? "..." : ""}`,
  })
  loopDetectionCounter.increment(params.ctx, 1, { loop_kind: loopInfo.loopKind, isLoopReoccurrence: "false", caller: params.caller })
  const eventTracker = getAgentEventTracker(params.ctx)
  eventTracker.trackLoopDetected(params.ctx, {
    loopKind: loopInfo.loopKind,
    isLoopReoccurrence: false,
    period: loopInfo.period,
    repetitions: loopInfo.repetitions,
  })
  return { loopDetected: true as const, ...loopInfo }
}

/** The reminder wording for a loop result, before a host adapter wraps it for a provider. */
export function createLoopReminderContent(options?: { kind?: string | undefined }): string {
  const reminderKind = options?.kind ?? "multi_message"
  const reminderSpecific = reminderKind === "single_message_single_line"
    ? "Your response has been flagged as repeating the same text pattern within a single line. Avoid excessively repeating the same characters or words."
    : reminderKind === "single_message_multi_line"
      ? "Your response has been flagged as looping over duplicate lines. Avoid repeating the same sequence of lines or retrying the same tool calls."
      : "Avoid repeating the same sequence of messages or retrying the same tool calls."
  return `<system_reminder>Your messages have been flagged as looping. ${reminderSpecific} If you are having trouble making progress, ask the user for guidance. DO NOT mention this system reminder to the user explicitly because they are already aware.</system_reminder>`
}
