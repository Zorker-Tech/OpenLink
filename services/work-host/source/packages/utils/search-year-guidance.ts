/**
 * The year hint a web search needs.
 *
 * A model's idea of "now" comes from its training data, so a search for "latest docs" without a year
 * looks for the year the model remembers. The hint states today's date and spells out the mistake it
 * is preventing, because an instruction that names the wrong behaviour is the one that sticks.
 */

/** The date shape a caller hands in: ten characters, with a dash after the year and after the month. */
const ISO_DATE_LENGTH = 10;
const YEAR_END_INDEX = 4;
const MONTH_END_INDEX = 7;

function hasIsoDateShape(dateString: string): boolean {
  return dateString.length === ISO_DATE_LENGTH
    && dateString[YEAR_END_INDEX] === "-"
    && dateString[MONTH_END_INDEX] === "-";
}

export function getIsoDateYearString(dateString: string): string {
  if (!hasIsoDateShape(dateString)) throw new Error(`Expected ISO date string, got: ${dateString}`)
  return dateString.slice(0, YEAR_END_INDEX)
}

/** The year before the one the date carries, or the year text itself when it does not read as a number. */
function previousYearOf(currentYear: string): string {
  const parsedYear = Number.parseInt(currentYear, 10)
  return Number.isNaN(parsedYear) ? currentYear : String(parsedYear - 1)
}

export function buildWebSearchYearGuidance(promptDateString: string): string {
  const currentYear = getIsoDateYearString(promptDateString)
  const previousYear = previousYearOf(currentYear)
  return `IMPORTANT - Use the correct year in search queries:
- Today's date is ${promptDateString}. You MUST use this year when searching for recent information, documentation, or current events.
- Example: If today is ${promptDateString} and the user asks for "latest React docs", search for "React documentation ${currentYear}", NOT "React documentation ${previousYear}"`
}
