import assert from "node:assert/strict"
import { test } from "node:test"

import {
  DETAILED_COMPACTION_PROMPT,
  MAX_SELF_SUMMARY_RETRIES,
  SELF_SUMMARIZATION_PROMPT,
  SELF_SUMMARY_CONTEXT_WINDOW_FRACTION,
  SELF_SUMMARY_NUM_TURNS,
  TAGGED_COMPACTION_INSTRUCTIONS,
} from "../../source/packages/agent/self-summary/constants.ts"

test("the retry and trigger defaults stay explicit", () => {
  assert.equal(MAX_SELF_SUMMARY_RETRIES, 3)
  assert.equal(SELF_SUMMARY_NUM_TURNS, 1_000)
  assert.equal(SELF_SUMMARY_CONTEXT_WINDOW_FRACTION, 0.9)
})

test("summary prompts preserve continuity needs and prohibit tool use", () => {
  assert.match(SELF_SUMMARIZATION_PROMPT, /the user's original query and your summary/)
  assert.match(SELF_SUMMARIZATION_PROMPT, /errors encountered and how they were resolved/)
  assert.match(SELF_SUMMARIZATION_PROMPT, /what remains to be done/)
  assert.match(SELF_SUMMARIZATION_PROMPT, /DO NOT call any tools/)

  assert.match(TAGGED_COMPACTION_INSTRUCTIONS, /state, next steps, and learnings/)
  assert.match(TAGGED_COMPACTION_INSTRUCTIONS, /<summary><\/summary>/)
  assert.match(TAGGED_COMPACTION_INSTRUCTIONS, /Do not call any tools/)

  for (const section of ["Primary Request and Intent", "Files and Code Sections", "Errors and fixes", "Pending Tasks", "Current Work", "Optional Next Step"]) {
    assert.ok(DETAILED_COMPACTION_PROMPT.includes(section), `${section} remains in the detailed handoff`)
  }
  assert.match(DETAILED_COMPACTION_PROMPT, /security-relevant instructions/)
  assert.match(DETAILED_COMPACTION_PROMPT, /Do NOT call any tools/)
})
