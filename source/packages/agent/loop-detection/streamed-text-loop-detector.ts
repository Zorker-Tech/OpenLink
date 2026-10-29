/**
 * Catching a model that has started repeating itself, as the repetition happens.
 *
 * Text arrives one character at a time, and the detector watches two shapes. A single line can repeat a
 * period inside itself — `abababab…` — which is caught by remembering, for each period length, how many
 * characters back the same character was found; a run long enough for that period, and long enough in
 * total, is a loop. Whole lines can repeat too — the same line, or the same block of lines, over and over —
 * which is caught the same way over a ring buffer of the lines seen so far, with the extra condition that
 * a multi-line loop has to be long enough in characters to be worth reporting, since a repeated three-line
 * block of punctuation is not a loop worth stopping.
 *
 * Two things make this bearable to run on every character. Lines that are only a box border are ignored —
 * a model drawing a table is repeating characters without repeating itself — and the whole check is on a
 * deadline: past it the detector gives up and says so, and a caller that sees the timeout knows the answer
 * is "not checked" rather than "not repeating". Code fences are tracked because the thresholds are laxer
 * inside one: a repeated line in a code sample is often deliberate.
 *
 * The character budget matters too: a line longer than the configured maximum is not appended to, so a
 * single enormous line cannot make the per-character work grow without bound.
 */

import { isBoxBorderLine, nextCodeFenceState } from "./streamed-text-line-classification.ts"

export interface StreamedTextLoopDetectorConfig {
  multiLineLoopMinRepetitions(): number
  multiLineLoopMinRepetitionsInCodeFence(): number
  maxLineLength(): number
  maxCheckTimeMs(): number
  singleLineLoopMinRepetitions(): number
  singleLineLoopMinRepetitionsInCodeFence(): number
  singleLineLoopMinPTimesK(): number
  singleLineLoopMinPTimesKInCodeFence(): number
  singleLineLoopMaxP(): number
  multiLineLoopMinPTimesK(): number
  multiLineLoopMinPTimesKInCodeFence(): number
  multiLineLoopMinTotalChars(): number
  multiLineLoopMinTotalCharsInCodeFence(): number
}

export interface StreamedTextLoopDetectorHooks {
  onSingleLineCheck?(event: { latencyMs: number; result: string; caller: string }): void
  onMultiLineCheck?(event: { latencyMs: number; result: string; caller: string }): void
  onTimeout?(event: { latencyMs: number; phase: string; caller: string }): void
}

interface SingleLineLoop {
  start: number
  period: number
  repetitions: number
  root: string
}

function isHighSurrogate(value: string): boolean {
  const code = value.charCodeAt(0)
  return value.length === 1 && code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(value: string): boolean {
  const code = value.charCodeAt(0)
  return value.length === 1 && code >= 0xdc00 && code <= 0xdfff
}

export class StreamedTextLoopDetector {
  readonly config: StreamedTextLoopDetectorConfig
  readonly hooks: StreamedTextLoopDetectorHooks | undefined
  currentLine = ""
  insideCodeFence = false
  startIdx = 0
  lineCount = 0
  detectedMultiLinePattern: string[] | null = null
  multiLinePeriodMatchRunLengths: number[]
  detectedSingleLineLoop: SingleLineLoop | null = null
  periodMatchRunLengths: number[]
  didTimeout = false
  readonly MULTI_LINE_LOOP_MIN_REPETITIONS: number
  readonly MAX_LINE_LENGTH: number
  readonly MAX_CHECK_TIME_MS: number
  readonly MAX_LINE_QUEUE_SIZE: number
  readonly SINGLE_LINE_LOOP_MIN_REPETITIONS: number
  readonly SINGLE_LINE_LOOP_MIN_P_TIMES_K: number
  readonly SINGLE_LINE_LOOP_MAX_P_LIMIT: number
  readonly lineBuffer: string[]
  private currentLineCodePoints: string[] = []
  private pendingHighSurrogate: string | undefined

  constructor(config: StreamedTextLoopDetectorConfig, hooks?: StreamedTextLoopDetectorHooks) {
    this.config = config
    this.hooks = hooks
    // A check time of zero or less means no deadline at all rather than a deadline that has passed.
    const configuredMaxCheckTimeMs = this.config.maxCheckTimeMs()
    this.MULTI_LINE_LOOP_MIN_REPETITIONS = this.config.multiLineLoopMinRepetitions()
    this.MAX_LINE_LENGTH = this.config.maxLineLength()
    this.MAX_CHECK_TIME_MS = configuredMaxCheckTimeMs > 0 ? configuredMaxCheckTimeMs : Number.POSITIVE_INFINITY
    this.MAX_LINE_QUEUE_SIZE = 50 * this.MULTI_LINE_LOOP_MIN_REPETITIONS
    this.SINGLE_LINE_LOOP_MIN_REPETITIONS = this.config.singleLineLoopMinRepetitions()
    this.SINGLE_LINE_LOOP_MIN_P_TIMES_K = this.config.singleLineLoopMinPTimesK()
    this.SINGLE_LINE_LOOP_MAX_P_LIMIT = this.config.singleLineLoopMaxP()
    this.lineBuffer = new Array(this.MAX_LINE_QUEUE_SIZE)
    this.periodMatchRunLengths = new Array(this.SINGLE_LINE_LOOP_MAX_P_LIMIT + 1).fill(0)
    this.multiLinePeriodMatchRunLengths = new Array(this.MAX_LINE_QUEUE_SIZE + 1).fill(0)
  }

  loopDetected(): boolean {
    return this.detectedSingleLineLoop !== null || this.detectedMultiLinePattern !== null
  }

  timedOut(): boolean {
    return this.didTimeout
  }

  /** A line whose non-whitespace characters are almost all border characters. */
  isBoxBorderLine(line: string): boolean {
    return isBoxBorderLine(line)
  }

  addText({ newText, caller }: { newText: string; caller: string }): boolean {
    // Once a loop has been found, or the check has run out of time, nothing more is looked at.
    if (this.loopDetected() || this.didTimeout) return this.loopDetected()
    const deadlineMs = performance.now() + this.MAX_CHECK_TIME_MS
    for (const character of newText) {
      if (this.pendingHighSurrogate !== undefined) {
        const pending = this.pendingHighSurrogate
        this.pendingHighSurrogate = undefined
        if (isLowSurrogate(character)) {
          const result = this.scanCharacter(pending + character, caller, deadlineMs)
          if (result !== null) return result
          continue
        }
        const result = this.scanCharacter(pending, caller, deadlineMs)
        if (result !== null) return result
      }
      if (isHighSurrogate(character)) {
        this.pendingHighSurrogate = character
        continue
      }
      const result = this.scanCharacter(character, caller, deadlineMs)
      if (result !== null) return result
    }
    return false
  }

  /** Adds one Unicode scalar to the current line and checks it as a single period unit. */
  private scanCharacter(character: string, caller: string, deadlineMs: number): boolean | null {
    if (character === "\n") {
      this.updateCodeFenceStateOnLineEnd(this.currentLine)
      if (this.currentLine.trim().length > 0 && !this.isBoxBorderLine(this.currentLine)) {
        this.addLineToQueue(this.currentLine)
        const pattern = this.checkForMultiLineLoop({ caller, deadlineMs })
        if (this.didTimeout) return false
        if (pattern !== null) {
          this.detectedMultiLinePattern = pattern
          return true
        }
      }
      this.currentLine = ""
      this.currentLineCodePoints = []
      this.periodMatchRunLengths.fill(0)
      return null
    }

    // The line cap is measured in UTF-16 units, matching string storage, while periods use code points.
    if (this.currentLine.length + character.length > this.MAX_LINE_LENGTH) return null
    this.currentLine += character
    this.currentLineCodePoints.push(character)
    const startedAt = performance.now()
    if (this.isBoxBorderLine(this.currentLine) || /\s/.test(character)) return null

    const position = this.currentLineCodePoints.length - 1
    const largestPeriod = Math.min(this.SINGLE_LINE_LOOP_MAX_P_LIMIT, position)
    const minimumCopies = this.insideCodeFence
      ? this.config.singleLineLoopMinRepetitionsInCodeFence()
      : this.SINGLE_LINE_LOOP_MIN_REPETITIONS
    const minimumPeriodWork = this.insideCodeFence
      ? this.config.singleLineLoopMinPTimesKInCodeFence()
      : this.SINGLE_LINE_LOOP_MIN_P_TIMES_K

    for (let period = 1; period <= largestPeriod; period++) {
      if ((period & 31) === 0 && this.markTimedOutIfNeeded({ caller, deadlineMs, phase: "single_line", startTime: startedAt })) return false
      if (this.currentLineCodePoints[position] === this.currentLineCodePoints[position - period]) {
        const matches = ++this.periodMatchRunLengths[period]!
        const repetitions = Math.floor(matches / period) + 1
        if (repetitions >= minimumCopies && period * repetitions >= minimumPeriodWork) {
          const patternPoints = this.currentLineCodePoints.slice(-period)
          const root = patternPoints.join("")
          this.hooks?.onSingleLineCheck?.({ latencyMs: performance.now() - startedAt, result: "loop_detected_single_line_substring", caller })
          this.detectedSingleLineLoop = {
            start: this.currentLine.length - root.length,
            period,
            repetitions,
            root,
          }
          return true
        }
      } else {
        this.periodMatchRunLengths[period] = 0
      }
    }
    this.hooks?.onSingleLineCheck?.({ latencyMs: performance.now() - startedAt, result: "no_loop_detected_single_line_substring", caller })
    return null
  }

  private addLineToQueue(line: string): void {
    const insertIdx = (this.startIdx + this.lineCount) % this.MAX_LINE_QUEUE_SIZE
    this.lineBuffer[insertIdx] = line
    if (this.lineCount < this.MAX_LINE_QUEUE_SIZE) this.lineCount++
    else this.startIdx = (this.startIdx + 1) % this.MAX_LINE_QUEUE_SIZE
  }

  private getLineAt(logicalIndex: number): string {
    const physicalIndex = (this.startIdx + logicalIndex) % this.MAX_LINE_QUEUE_SIZE
    return this.lineBuffer[physicalIndex]!
  }

  /** Whether the line just added continues a run of lines that repeats with some period. */
  private checkForMultiLineLoop({ caller, deadlineMs }: { caller: string; deadlineMs: number }): string[] | null {
    const startTime = performance.now()
    const currentLine = this.getLineAt(this.lineCount - 1)
    const maxPeriod = Math.min(this.lineCount - 1, this.MAX_LINE_QUEUE_SIZE - 1)
    for (let p = 1; p <= maxPeriod; p++) {
      if ((p & 7) === 0 && this.markTimedOutIfNeeded({ caller, deadlineMs, phase: "multi_line", startTime })) return null
      const priorIndex = this.lineCount - 1 - p
      const priorLine = this.getLineAt(priorIndex)
      if (currentLine === priorLine) {
        const matched = ++this.multiLinePeriodMatchRunLengths[p]!
        const repetitions = Math.floor(matched / p) + 1
        const pTimesK = p * repetitions
        const insideFence = this.insideCodeFence
        const minReps = insideFence ? this.config.multiLineLoopMinRepetitionsInCodeFence() : this.MULTI_LINE_LOOP_MIN_REPETITIONS
        const minPTimesK = insideFence ? this.config.multiLineLoopMinPTimesKInCodeFence() : this.config.multiLineLoopMinPTimesK()
        const minTotalChars = insideFence ? this.config.multiLineLoopMinTotalCharsInCodeFence() : this.config.multiLineLoopMinTotalChars()
        if (repetitions >= minReps && pTimesK >= minPTimesK) {
          const pattern: string[] = []
          const startOfRoot = this.lineCount - 1 - p + 1
          for (let j = startOfRoot; j < this.lineCount; j++) pattern.push(this.getLineAt(j))
          const rootChars = pattern.reduce((sum, line) => sum + line.length, 0)
          const totalRepeatedChars = rootChars * repetitions
          // A short block repeated many times is not worth stopping a turn for.
          if (totalRepeatedChars < minTotalChars) continue
          this.detectedMultiLinePattern = pattern
          this.hooks?.onMultiLineCheck?.({ latencyMs: performance.now() - startTime, result: "loop_detected", caller })
          return pattern
        }
      } else {
        this.multiLinePeriodMatchRunLengths[p] = 0
      }
    }
    this.hooks?.onMultiLineCheck?.({ latencyMs: performance.now() - startTime, result: "no_loop_detected", caller })
    return null
  }

  private markTimedOutIfNeeded({ caller, deadlineMs, phase, startTime }: { caller: string; deadlineMs: number; phase: string; startTime: number }): boolean {
    if (this.didTimeout) return true
    if (performance.now() < deadlineMs) return false
    this.didTimeout = true
    this.hooks?.onTimeout?.({ latencyMs: performance.now() - startTime, phase, caller })
    return true
  }

  /** A line with an odd number of fence markers opens or closes a code fence. */
  private updateCodeFenceStateOnLineEnd(line: string): void {
    this.insideCodeFence = nextCodeFenceState(line, this.insideCodeFence)
  }

  getSingleLineLoopInfo(): { pattern: string; repetitions: number; period: number } | null {
    if (!this.detectedSingleLineLoop) return null
    return { pattern: this.detectedSingleLineLoop.root, repetitions: this.detectedSingleLineLoop.repetitions, period: this.detectedSingleLineLoop.period }
  }

  getMultiLineLoopInfo(): { pattern: string; repetitions: number } | null {
    if (!this.detectedMultiLinePattern) return null
    return { pattern: this.detectedMultiLinePattern.join("\n"), repetitions: this.MULTI_LINE_LOOP_MIN_REPETITIONS }
  }

  reset(): void {
    this.currentLine = ""
    this.currentLineCodePoints = []
    this.pendingHighSurrogate = undefined
    this.insideCodeFence = false
    this.didTimeout = false
    this.lineCount = 0
    this.startIdx = 0
    this.detectedMultiLinePattern = null
    this.detectedSingleLineLoop = null
    this.periodMatchRunLengths.fill(0)
    this.multiLinePeriodMatchRunLengths.fill(0)
  }
}
