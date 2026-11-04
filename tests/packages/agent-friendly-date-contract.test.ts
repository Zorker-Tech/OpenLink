import assert from "node:assert/strict"
import test from "node:test"
import { getFriendlyDateForTimeZone } from "../../source/packages/agent/prompts/friendly-date.ts"

test("a date is rendered as a readable weekday, month, day and year", () => {
  assert.match(getFriendlyDateForTimeZone("UTC"), /^[A-Za-z]+ [A-Za-z]{3} \d{1,2}, \d{4}$/)
})

test("an invalid requested zone falls back to the machine's local zone", () => {
  const localDate = getFriendlyDateForTimeZone()
  const fallback = getFriendlyDateForTimeZone("Invalid/Slate-Zone")

  assert.equal(fallback, localDate)
})

test("when internationalization data cannot format a date, the ISO day remains available", () => {
  const originalFormatter = Intl.DateTimeFormat
  try {
    Intl.DateTimeFormat = class {
      constructor() {
        throw new RangeError("formatting data unavailable")
      }
    } as never

    assert.match(getFriendlyDateForTimeZone("UTC"), /^\d{4}-\d{2}-\d{2}$/)
  } finally {
    Intl.DateTimeFormat = originalFormatter
  }
})
