/**
 * An automation that failed, told apart from its detail text.
 *
 * The detail is normalized — bracketed parts, identifiers, addresses and numbers are dropped — so that the same kind
 * of failure reads the same however it was reported, and a background automation is exactly a scheduled or event
 * trigger.
 */

/** How many words of a detail are kept: enough to name the kind of failure, and not the whole message. */
const KIND_WORDS = 6;

/** The triggers that run without the user in front of them. */
const BACKGROUND_TRIGGERS: readonly string[] = ["schedule", "event"];

/** What is dropped from a detail before it is read as a kind: the parts that differ between two reports of one failure. */
const NOISE: readonly RegExp[] = [
  /\([^)]*\)/g,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
  /0x[0-9a-f]+/g,
  /\d+/g,
  /[^a-z ]+/g,
];

/** Whether this trigger runs a background automation rather than one the user started. */
export function isBackgroundAutomationTrigger(trigger: string): boolean {
  return BACKGROUND_TRIGGERS.includes(trigger);
}

/**
 * The kind of failure a detail text describes: what is left of it once the parts that change between reports are gone,
 * and the first few words of that — or "unknown" when nothing is left to name it by.
 */
export function normalizeAutomationErrorKind(detail: string | null | undefined): string {
  const text = (detail ?? "").trim().toLowerCase();
  if (text.length === 0) return "unknown";
  const stripped = NOISE.reduce((remaining, pattern) => remaining.replace(pattern, " "), text);
  const words = stripped.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, KIND_WORDS);
  return words.join(" ") || "unknown";
}

/**
 * Whether a failure should be told to the user: the first time, and then only when the count doubles — so a repeated
 * failure is noticed without becoming a stream of notifications.
 */
export function shouldNotifyAutomationFailure(occurrence: number): boolean {
  return occurrence <= 1 || (occurrence & (occurrence - 1)) === 0;
}
