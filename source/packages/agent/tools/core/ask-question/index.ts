import { z } from "zod"

export {
  formatAskQuestionResultAsString,
  shouldReceiptAskQuestionResult,
} from "../../../../../adapters/interop/agent/ask-question-result-adapter.ts"

export const askQuestionSchema = z.object({
  id: z.string().describe("Unique identifier for this question"),
  prompt: z.string().describe("The question text to display to the user, without the options."),
  options: z.array(z.object({
    id: z.string().describe("Unique identifier for this option"),
    label: z.string().describe("Display text for this option"),
  })).min(2).describe("Array of answer options (minimum 2 required)"),
  allow_multiple: z.boolean().optional().describe("If true, user can select multiple options. Defaults to false."),
})
