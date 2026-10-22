import { test } from "node:test"
import assert from "node:assert/strict"

import { sanitizeSystemReminderContent } from "../../source/packages/hooks/system-reminder-sanitizing.ts"

test("a reminder tag in hook content is defused, opening or closing", () => {
  assert.equal(sanitizeSystemReminderContent("<system_reminder>"), "<system_reminder_>")
  assert.equal(sanitizeSystemReminderContent("</system_reminder>"), "</system_reminder_>")
  assert.equal(
    sanitizeSystemReminderContent("before <system_reminder>inside</system_reminder> after"),
    "before <system_reminder_>inside</system_reminder_> after",
    "the text around the tag is untouched",
  )
  assert.equal(
    sanitizeSystemReminderContent("<system_reminder></system_reminder><system_reminder></system_reminder>"),
    "<system_reminder_></system_reminder_><system_reminder_></system_reminder_>",
    "every occurrence is defused, not only the first",
  )
})

test("the tag is matched in any case, and written out defused in one", () => {
  assert.equal(sanitizeSystemReminderContent("<SYSTEM_REMINDER>"), "<system_reminder_>", "the defused tag is written lower case")
  assert.equal(sanitizeSystemReminderContent("</System_Reminder>"), "</system_reminder_>")
})

test("only the tag itself is defused, not anything that looks like it", () => {
  const untouched = [
    "no tags here",
    "system_reminder",
    "<system_reminder",
    "system_reminder>",
    "<system_reminder/>",
    '<system_reminder attr="x">',
    "<system_reminder >",
    "< /system_reminder>",
    "<system_reminder_>",
    "</system_reminder_>",
    "",
  ]
  for (const content of untouched) {
    assert.equal(sanitizeSystemReminderContent(content), content, content)
  }
  assert.equal(sanitizeSystemReminderContent("Already <system_reminder_> defused"), "Already <system_reminder_> defused", "defusing twice changes nothing more")
  assert.throws(() => sanitizeSystemReminderContent(7 as never), TypeError, "content that is not text is a caller's mistake")
})
