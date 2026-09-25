/**
 * Today's date, written the way a person would say it.
 *
 * The prompt tells the agent what day it is, because a model's sense of the current date comes from its
 * training and is wrong. The date is formatted for a named time zone when one is known, and for the
 * machine's own when it is not; an environment whose internationalization data cannot format the date
 * at all falls back to the ISO day rather than to no date, since a wrong-looking date is still better
 * than none.
 */

function buildFriendlyDate(date: Date, timeZone?: string): string | undefined {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      month: "short",
      day: "2-digit",
      year: "numeric",
    })
    const partLookup: Record<string, string> = {}
    for (const part of formatter.formatToParts(date)) {
      if (part.type === "literal") continue
      partLookup[part.type] = part.value
    }
    const weekday = partLookup.weekday
    const month = partLookup.month
    const day = partLookup.day
    const year = partLookup.year
    if (weekday && month && day && year) {
      const normalizedDay = Number.parseInt(day, 10).toString()
      return `${weekday} ${month} ${normalizedDay}, ${year}`
    }
  } catch {
    // Fall through to the local time zone, then to the ISO date.
  }
  return undefined
}

export function getFriendlyDateForTimeZone(timeZone?: string): string {
  const now = new Date()
  const formatted = buildFriendlyDate(now, timeZone)
  if (formatted) return formatted
  const fallbackFormatted = buildFriendlyDate(now, undefined)
  if (fallbackFormatted) return fallbackFormatted
  return now.toISOString().split("T")[0]!
}
