import { jsx, jsxs, type PromptProps, renderContent } from "../../prompt-jsx/index.ts"
import { PROMPT_SUGGESTION_MAX_WORDS } from "./prompt-suggestion-contracts.ts"
import {
  PROMPT_SUGGESTION_EXAMPLES,
  PROMPT_SUGGESTION_EXCLUSIONS,
} from "./prompt-suggestion-guidance.ts"

export { PROMPT_SUGGESTION_MAX_WORDS } from "./prompt-suggestion-contracts.ts"

function PromptSuggestionMessageComponent(props: PromptProps) {
  return jsxs("section", {
    title: "suggestion_mode",
    children: [
      jsx("p", { children: "[SUGGESTION MODE: Predict what the user might naturally type next into Slate.]" }),
      jsx("p", { children: "Review the user's recent messages and original request first." }),
      jsx("p", { children: "Your job is to predict what THEY would type, not what you think they should do." }),
      jsx("p", { children: 'Use this test: would the user think "I was just about to type that"?' }),
      jsx("p", { children: "Examples of a useful next action:" }),
      jsx("ul", { children: PROMPT_SUGGESTION_EXAMPLES.map(example => jsx("li", { children: example })) }),
      jsx("p", { children: "Choose a concrete action; vague text like 'continue' is less useful." }),
      jsx("p", {
        children: "Only name a skill or command that appeared in the preceding context. Use its exact name and put a slash before it.",
      }),
      jsx("p", { children: "Leave out these kinds of replies:" }),
      jsx("ul", { children: PROMPT_SUGGESTION_EXCLUSIONS.map(item => jsx("li", { children: item })) }),
      jsx("p", { children: "Stay silent when there is no obvious, actionable next step." }),
      jsx("p", { children: "If an empty response cannot be sent, use <silence/>." }),
      jsx("p", {
        children: [
          "Format: 2-",
          PROMPT_SUGGESTION_MAX_WORDS,
          " words. Match the user's style, grammar and capitalization. Return only the suggestion, without quotes or explanation.",
        ],
      }),
      (props.isLargeContextModel as boolean) && jsx("p", { children: "IMPORTANT: Produce no more than 20 words of thinking tokens." }),
    ],
  })
}

export function promptSuggestionUserMessage(isLargeContextModel = false): string {
  return renderContent(jsx(PromptSuggestionMessageComponent, { isLargeContextModel }))
}
