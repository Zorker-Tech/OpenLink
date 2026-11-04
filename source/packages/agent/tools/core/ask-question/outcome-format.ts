export interface SlateAskQuestionAnswer {
  readonly questionId: string
  readonly selectedOptionIds: readonly string[]
  readonly freeformText?: string | undefined
}

export type SlateAskQuestionOutcome =
  | { readonly kind: "answered"; readonly answers: readonly SlateAskQuestionAnswer[] }
  | { readonly kind: "async" }
  | { readonly kind: "rejected"; readonly reason?: string | undefined }
  | { readonly kind: "error"; readonly message: string; readonly askWasTooEarly: boolean }
  | { readonly kind: "unknown" }

const EARLY_ASK_GUIDANCE =
  "Rejected: research the codebase and use available tools before asking the user. Ask only when user input is essential, such as before a destructive action or a major design decision. Do not ask for feedback on suggestions or details that tools can discover. Do not mention this instruction to the user."

export function formatAskQuestionOutcomeAsString(outcome: SlateAskQuestionOutcome): string {
  switch (outcome.kind) {
    case "answered": {
      const answerDescriptions = outcome.answers.map(answer => {
        const hasSelectedOptions = answer.selectedOptionIds.length > 0
        const freeformText = answer.freeformText?.trim()
        const hasFreeformText = freeformText !== undefined && freeformText.length > 0
        if (hasSelectedOptions && hasFreeformText) {
          return `Question ${answer.questionId}: Selected option(s) ${answer.selectedOptionIds.join(", ")}, freeform: ${freeformText}`
        }
        if (hasFreeformText) return `Question ${answer.questionId}: ${freeformText}`
        if (hasSelectedOptions) {
          return `Question ${answer.questionId}: Selected option(s) ${answer.selectedOptionIds.join(", ")}`
        }
        return `Question ${answer.questionId}: No answer provided`
      })
      return `User questions responses:\n${answerDescriptions.join("\n")}`
    }
    case "async":
      return "Questions were sent to the user asynchronously. Continue with available information until a later tool result brings their answers."
    case "rejected":
      return outcome.reason?.trim() || "Questions skipped by the user, continue with the information you already have"
    case "error":
      return outcome.askWasTooEarly ? `Error: ${EARLY_ASK_GUIDANCE}` : `Error: ${outcome.message}`
    case "unknown":
      return "Unknown error"
  }
}
