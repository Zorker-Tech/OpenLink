/**
 * What the platform does when something that cannot happen happens.
 *
 * An invariant violation is reported rather than thrown past the caller, and in a packaged build the message is
 * stripped from the report — the stack is what identifies where it came from — so a report can be sent without carrying
 * whatever the message happened to include. Installing a reporter twice is itself a violation, and the report it takes
 * is the name and the first frame outside the reporting machinery.
 */
export interface SlateInvariantReport { readonly name: string; readonly frame: string | null; }
export class SlateInvariantViolation extends Error { constructor(message: string) { super(message); this.name = "SlateInvariantViolation"; } }
export const STRIPPED_INVARIANT_MESSAGE = "Invariant violation (message stripped in packaged builds; the stack identifies the site)";
const FRAME_LINE = /^at /; const OWN_FRAME = /^at (?:new SlateInvariantViolation\b|invariant\b|installInvariantReporter\b)/; let installedReporter: ((report: SlateInvariantReport) => void) | null = null;
export function installInvariantReporter(reporter: (report: SlateInvariantReport) => void): () => void { invariant(installedReporter === null, "installInvariantReporter: a reporter is already installed"); installedReporter = reporter; return () => { if (installedReporter === reporter) installedReporter = null; }; }
export function invariantMessagesStripped(): boolean { return true; }
function headerOf(violation: SlateInvariantViolation): string { return violation.message === "" ? violation.name : `${violation.name}: ${violation.message}`; }
export function topApplicationFrame(violation: SlateInvariantViolation): string | null { const stack = violation.stack; const header = headerOf(violation); if (stack == null || !stack.startsWith(header)) return null; for (const raw of stack.slice(header.length).split("\n")) { const frame = raw.trim(); if (!FRAME_LINE.test(frame) || OWN_FRAME.test(frame)) continue; return frame; } return null; }
export function invariant(condition: unknown, message?: string | (() => string)): asserts condition { if (condition) return; const violationMessage = invariantMessagesStripped() ? STRIPPED_INVARIANT_MESSAGE : typeof message === "function" ? message() : message ?? ""; const violation = new SlateInvariantViolation(violationMessage); installedReporter?.({ name: violation.name, frame: topApplicationFrame(violation) }); throw violation; }
