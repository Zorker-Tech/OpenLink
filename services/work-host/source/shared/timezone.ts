/**
 * Reading a time zone, and saying how far it is from UTC.
 *
 * A zone is valid when the platform's own date machinery accepts it, and the offset is written the way a user reads it
 * — with a sign, hours and minutes, and the zone's own name when it has one — while a zone nobody recognizes is nothing
 * rather than a guess.
 */

/** The locale the platform reads its own offsets in; the offset is the same in any, but the words are not. */
const LOCALE = "en-US";

/** Whether the platform's date machinery accepts this zone name. */
export function isKnownTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat(LOCALE, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The offset a zone is at, as the platform writes it (`GMT+05:30`), or nothing when the zone is not one. */
function offsetNameOf(now: Date, timeZone: string): string | null {
  const parts = new Intl.DateTimeFormat(LOCALE, { timeZone, timeZoneName: "shortOffset" }).formatToParts(now);
  return parts.find((part) => part.type === "timeZoneName")?.value ?? null;
}

/**
 * How far this zone is from UTC, written the way a user reads it: `UTC`, `UTC+5:30`, `UTC-8`.
 *
 * A zone nobody recognizes is nothing at all — the caller shows the zone's name without an offset rather than an offset
 * that would be wrong.
 */
export function utcOffsetOf(now: Date, timeZone: string): string | null {
  try {
    const written = offsetNameOf(now, timeZone);
    if (written == null) return null;
    // The platform writes "GMT" for a zone at UTC and "GMT±h:mm" otherwise; what is left is the offset itself.
    const offset = written.replace(/^GMT/, "");
    return `UTC${offset.length > 0 ? offset : "+0"}`;
  } catch {
    return null;
  }
}

/** The line the prompt carries about the clock the user lives on. */
const TIME_SECTION = "## Time";

/** What the agent is told to do with the times it reads, which are all UTC. */
const CONVERSION_RULE =
  'Your box and tools run on a UTC clock, but the user lives in {zone}. So any time you report to them — a git or gh timestamp, a file\'s mtime, a log line, "finished at", a schedule — is a UTC value: convert it to the user\'s zone and label it clearly (a short tag like "PT" is enough) rather than parroting the raw UTC time back.';

/** The time section of a system prompt, or nothing at all when the user has no zone. */
export function timeZonePromptSection(timeZone: string | null | undefined, now = new Date()): string {
  if (timeZone == null || timeZone.length === 0) return "";
  const offset = utcOffsetOf(now, timeZone);
  const zone = offset != null ? `${timeZone} (currently ${offset})` : timeZone;
  return [TIME_SECTION, CONVERSION_RULE.replace("{zone}", zone)].join("\n");
}
