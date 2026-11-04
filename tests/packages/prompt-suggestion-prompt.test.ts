import assert from "node:assert/strict"
import { test } from "node:test"

import {
  PROMPT_SUGGESTION_MAX_WORDS,
  promptSuggestionUserMessage,
} from "../../source/packages/agent/prompts/prompt-suggestion.ts"

test("suggestion instructions ask for the user's likely next action and allow silence", () => {
  const prompt = promptSuggestionUserMessage()

  assert.match(prompt, /SUGGESTION MODE/)
  assert.match(prompt, /predict what (?:they|the user) would type/i)
  assert.match(prompt, /not what .* should do/i)
  assert.match(prompt, /questions/i)
  assert.match(prompt, /skills? or command/i)
  assert.match(prompt, /2-12 words/i)
  assert.match(prompt, new RegExp(`2-${PROMPT_SUGGESTION_MAX_WORDS} words`))
  assert.match(prompt, /return only the suggestion.*without quotes/i)
  assert.match(prompt, /silence/i)
})

test("large-context models receive the separate thinking limit", () => {
  assert.doesNotMatch(promptSuggestionUserMessage(), /thinking tokens/)
  assert.match(promptSuggestionUserMessage(true), /no more than 20 words of thinking tokens/i)
})
