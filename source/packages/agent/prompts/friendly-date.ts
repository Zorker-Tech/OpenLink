/**
 * Today's date, written the way a person would say it.
 *
 * The prompt tells the agent what day it is, because a model's sense of the current date comes from its
 * training and is wrong. The date is formatted for a named time zone when one is known, and for the
 * machine's own when it is not; an environment whose internationalization data cannot format the date
 * at all falls back to the ISO day rather than to no date, since a wrong-looking date is still better
 * than none.
 */

interface FriendlyDateParts {
  readonly weekday?: string | undefined
  readonly month?: string | undefined
  readonly day?: string | undefined
  readonly year?: string | undefined
}

function datePartsInZone(date: Date, timeZone?: string): FriendlyDateParts | undefined {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      month: "short",
      day: "2-digit",
      year: "numeric",
    })
    const values: Record<string, string> = {}
    for (const part of formatter.formatToParts(date)) {
      if (part.type === "literal") continue
      values[part.type] = part.value
    }
    return {
      weekday: values.weekday,
      month: values.month,
      day: values.day,
      year: values.year,
    }
  } catch {
    return undefined
  }
}

function renderFriendlyDate(parts: FriendlyDateParts | undefined): string | undefined {
  if (parts?.weekday === undefined || parts.month === undefined || parts.day === undefined || parts.year === undefined) {
    return undefined
  }
  const dayNumber = Number.parseInt(parts.day, 10)
  if (!Number.isFinite(dayNumber)) return undefined
  return `${parts.weekday} ${parts.month} ${dayNumber}, ${parts.year}`
}

export function getFriendlyDateForTimeZone(timeZone?: string): string {
  const now = new Date()
  const formatted = renderFriendlyDate(datePartsInZone(now, timeZone))
  if (formatted) return formatted
  const fallbackFormatted = renderFriendlyDate(datePartsInZone(now, undefined))
  if (fallbackFormatted) return fallbackFormatted
  return now.toISOString().slice(0, 10)
}
