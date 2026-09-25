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

/** Characters that only ever draw a border, so a line made of them is not a repeated line. */
const BOX_DRAWING_CHARS = new Set([
  "─", "━", "═", "-", "_",
  "│", "┃", "║", "|",
  "┌", "┐", "└", "┘", "╔", "╗", "╚", "╝", "┏", "┓", "┗", "┛", "╓", "╖", "╙", "╜",
  "├", "┤", "┬", "┴", "┼", "╟", "╢", "╤", "╧", "╫", "╠", "╣", "╦", "╩", "╬", "╞", "╡", "╥", "╨", "╪",
  "+",
])

interface SingleLineLoop {
  start: number
  period: number
  repetitions: number
  root: string
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
    let boxCharCount = 0
    let totalNonWhitespace = 0
    for (const char of line) {
      if (char !== " " && char !== "\t") totalNonWhitespace++
      if (BOX_DRAWING_CHARS.has(char)) boxCharCount++
    }
    if (totalNonWhitespace === 0) return false
    return boxCharCount / totalNonWhitespace >= 0.8
  }

  addText({ newText, caller }: { newText: string; caller: string }): boolean {
    // Once a loop has been found, or the check has run out of time, nothing more is looked at.
    if (this.loopDetected() || this.didTimeout) return this.loopDetected()
    const deadlineMs = performance.now() + this.MAX_CHECK_TIME_MS
    for (const char of newText) {
      if (char === "\n") {
        this.updateCodeFenceStateOnLineEnd(this.currentLine)
        if (this.currentLine.trim().length > 0 && !this.isBoxBorderLine(this.currentLine)) {
          this.addLineToQueue(this.currentLine)
          const detectedPattern = this.checkForMultiLineLoop({ caller, deadlineMs })
          if (this.didTimeout) return false
          if (detectedPattern !== null) {
            this.detectedMultiLinePattern = detectedPattern
            return true
          }
        }
        this.currentLine = ""
        this.periodMatchRunLengths.fill(0)
      } else {
        // A line past the limit keeps its first characters and drops the rest.
        if (this.currentLine.length >= this.MAX_LINE_LENGTH) continue
        this.currentLine += char
        const startTime = performance.now()
        if (!this.isBoxBorderLine(this.currentLine) && !/\s/.test(char)) {
          const pos = this.currentLine.length - 1
          const maxP = Math.min(this.SINGLE_LINE_LOOP_MAX_P_LIMIT, pos)
          const minReps = this.insideCodeFence ? this.config.singleLineLoopMinRepetitionsInCodeFence() : this.SINGLE_LINE_LOOP_MIN_REPETITIONS
          const minPTimesK = this.insideCodeFence ? this.config.singleLineLoopMinPTimesKInCodeFence() : this.SINGLE_LINE_LOOP_MIN_P_TIMES_K
          for (let p = 1; p <= maxP; p++) {
            // The deadline is only read every 32 periods, which is often enough and cheap.
            if ((p & 31) === 0 && this.markTimedOutIfNeeded({ caller, deadlineMs, phase: "single_line", startTime })) return false
            if (this.currentLine[pos] === this.currentLine[pos - p]) {
              const matched = ++this.periodMatchRunLengths[p]!
              const repetitions = Math.floor(matched / p) + 1
              const pTimesK = p * repetitions
              if (repetitions >= minReps && pTimesK >= minPTimesK) {
                this.hooks?.onSingleLineCheck?.({ latencyMs: performance.now() - startTime, result: "loop_detected_single_line_substring", caller })
                const root = this.currentLine.slice(this.currentLine.length - p, this.currentLine.length)
                this.detectedSingleLineLoop = { start: this.currentLine.length - p, period: p, repetitions, root }
                return true
              }
            } else {
              this.periodMatchRunLengths[p] = 0
            }
          }
          this.hooks?.onSingleLineCheck?.({ latencyMs: performance.now() - startTime, result: "no_loop_detected_single_line_substring", caller })
        }
      }
    }
    return false
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
    if (line.length === 0) return
    const matches = line.match(/```+(?!`)/g)
    if (!matches || matches.length === 0) return
    if (matches.length % 2 === 1) this.insideCodeFence = !this.insideCodeFence
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
