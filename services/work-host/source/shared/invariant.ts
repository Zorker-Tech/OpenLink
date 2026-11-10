/**
 * What the platform does when something that cannot happen happens.
 *
 * An invariant violation is reported rather than thrown past the caller, and in a packaged build the message is
 * stripped from the report — the stack is what identifies where it came from — so a report can be sent without carrying
 * whatever the message happened to include. Installing a reporter twice is itself a violation, and the report it takes
 * is the name and the first frame outside the reporting machinery.
 */
export interface SlateInvariantReport { readonly name: string; readonly frame: string | null; }

export class SlateInvariantViolation extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = "SlateInvariantViolation"
  }
}

export const STRIPPED_INVARIANT_MESSAGE = "Invariant violation (message stripped in packaged builds; the stack identifies the site)"

/** The line a stack frame is written on, and the frames that belong to the reporting machinery rather than a caller. */
const STACK_FRAME = /^at /
const REPORTING_FRAME = /^at (?:new SlateInvariantViolation\b|invariant\b|installInvariantReporter\b)/

let reporterInUse: ((account: SlateInvariantReport) => void) | null = null

/** Installs the one reporter this module will hand violations to; a second install is a violation itself. */
export function installInvariantReporter(observer: (account: SlateInvariantReport) => void): () => void {
  invariant(reporterInUse === null, "installInvariantReporter: a reporter is already installed")
  reporterInUse = observer
  return () => {
    if (reporterInUse === observer) reporterInUse = null
  }
}

export function invariantMessagesStripped(): boolean { return true }

/** What a violation's stack begins with: its name, and its detail when it carries one. */
function violationHeader(breach: SlateInvariantViolation): string {
  return breach.message === "" ? breach.name : `${breach.name}: ${breach.message}`
}

/** The first frame below the reporting machinery, or nothing when the stack is not one this platform wrote. */
function reportableFrameIn(trace: string, prefix: string): string | null {
  for (const text of trace.slice(prefix.length).split("\n")) {
    const line = text.trim()
    if (!STACK_FRAME.test(line) || REPORTING_FRAME.test(line)) continue
    return line
  }
  return null
}

export function topApplicationFrame(breach: SlateInvariantViolation): string | null {
  const trace = breach.stack
  const prefix = violationHeader(breach)
  if (trace == null || !trace.startsWith(prefix)) return null
  return reportableFrameIn(trace, prefix)
}

/** The detail a violation carries: the stripped one while builds strip messages, otherwise the caller's. */
function violationDetail(detail?: string | (() => string)): string {
  if (invariantMessagesStripped()) return STRIPPED_INVARIANT_MESSAGE
  return typeof detail === "function" ? detail() : detail ?? ""
}

export function invariant(condition: unknown, detail?: string | (() => string)): asserts condition {
  if (condition) return
  const breach = new SlateInvariantViolation(violationDetail(detail))
  reporterInUse?.({ name: breach.name, frame: topApplicationFrame(breach) })
  throw breach
}
