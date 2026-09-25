/**
 * The message that asks for a suggestion of what the user would type next.
 *
 * The suggestion is shown to the user as a next-step they can accept, so the model has to be told what
 * it is predicting: not what would be useful, not what it would do, but what this particular user would
 * naturally type. Most of the instructions are examples of that distinction and of what to stay silent
 * about — an evaluation, a question, or a new idea is not a suggestion, and silence is the right answer
 * when nothing obvious follows.
 *
 * The length limit is a word count rather than a token count, because the suggestion is shown as text
 * in a place sized for a phrase.
 */

import { jsx, jsxs, type PromptProps } from "../../prompt-jsx/index.ts"
import { renderContent } from "../../prompt-jsx/index.ts"

export const PROMPT_SUGGESTION_MAX_WORDS = 12

function PromptSuggestionMessageComponent(props: PromptProps) {
  return jsxs("section", {
    title: "suggestion_mode",
    children: [
      jsx("p", { children: "[SUGGESTION MODE: Suggest what user might naturally type next into Slate.]" }),
      jsx("p", { children: "FIRST: Look at user's recent messages and original request." }),
      jsx("p", { children: "Your job is to predict what THEY would type - not what you think they should do." }),
      jsx("p", { children: 'THE TEST: Would they think "I was just about to type that"?' }),
      jsx("p", { children: "EXAMPLES:" }),
      jsxs("ul", {
        children: [
          jsxs("li", { children: ['User asked "fix the bug and run tests", bug is fixed →', " ", '"run the tests"'] }),
          jsx("li", { children: 'After code written → "Try it out"' }),
          jsx("li", { children: "The platform offers options → suggest the one the user would likely pick, based on conversation" }),
          jsx("li", { children: 'The platform asks to continue or says it will do something next → "yes" or "Go ahead"' }),
          jsx("li", { children: 'Task complete, obvious follow-up → "Commit this" or "push it"' }),
          jsx("li", { children: "After error or misunderstanding → silence (let them assess/correct)" }),
        ],
      }),
      jsx("p", { children: 'Be specific: "run the tests" beats "continue".' }),
      jsx("p", {
        children:
          'Pay special attention to the user\'s Agent Skills and Commands. If there\'s one that\'s perfect for the situation, suggest it by its actual name with a leading slash (e.g. "/commit-and-push"). NEVER suggest skills you don\'t see in previous context.',
      }),
      jsx("p", { children: "NEVER SUGGEST:" }),
      jsxs("ul", {
        children: [
          jsx("li", { children: 'Evaluative ("Looks good", "thanks")' }),
          jsx("li", { children: 'Non-actionable ("let me try it", "i\'m testing now", "No thanks")' }),
          jsx("li", { children: 'Questions ("what about...?", "can we...?")' }),
          jsx("li", { children: 'LLM-voice ("Let me...", "I\'ll...", "here\'s...")' }),
          jsx("li", { children: "New ideas they didn't ask about" }),
          jsx("li", { children: "Multiple sentences" }),
          jsx("li", { children: "Anything when the user is in Debug mode (let them drive)" }),
        ],
      }),
      jsx("p", {
        children:
          "Stay silent (output nothing) if next step isn't OBVIOUS from what user said or most likely response is not actionable by agent.",
      }),
      jsx("p", { children: "If you cannot output nothing, just output <silence/>." }),
      jsxs("p", {
        children: [
          "Format: 2-",
          PROMPT_SUGGESTION_MAX_WORDS,
          " words, match user's style/grammar/capitalization. Or nothing.",
        ],
      }),
      jsx("p", { children: "Reply with ONLY suggestion, no quotes or explanation." }),
      (props.isLargeContextModel as boolean) && jsx("p", { children: "IMPORTANT: Produce no more than 20 words of thinking tokens." }),
    ],
  })
}

export function promptSuggestionUserMessage(isLargeContextModel = false): string {
  return renderContent(jsx(PromptSuggestionMessageComponent, { isLargeContextModel }))
}
