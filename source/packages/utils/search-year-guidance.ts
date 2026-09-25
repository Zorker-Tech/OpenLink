/**
 * The year hint a web search needs.
 *
 * A model's idea of "now" comes from its training data, so a search for "latest docs" without a year
 * looks for the year the model remembers. The hint states today's date and spells out the mistake it
 * is preventing, because an instruction that names the wrong behaviour is the one that sticks.
 */

export function getIsoDateYearString(dateString: string): string {
  if (dateString.length !== 10 || dateString[4] !== "-" || dateString[7] !== "-") {
    throw new Error(`Expected ISO date string, got: ${dateString}`)
  }
  return dateString.slice(0, 4)
}

export function buildWebSearchYearGuidance(promptDateString: string): string {
  const currentYear = getIsoDateYearString(promptDateString)
  const parsedYear = Number.parseInt(currentYear, 10)
  const previousYear = Number.isNaN(parsedYear) ? currentYear : String(parsedYear - 1)
  return `IMPORTANT - Use the correct year in search queries:
- Today's date is ${promptDateString}. You MUST use this year when searching for recent information, documentation, or current events.
- Example: If today is ${promptDateString} and the user asks for "latest React docs", search for "React documentation ${currentYear}", NOT "React documentation ${previousYear}"`
}
