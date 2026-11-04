/** Short-lived sections that sit beside the session summary in the first user message. */
import { jsx, type PromptNode } from "../../prompt-jsx/index.ts"

interface ContentSectionInput {
  readonly content: PromptNode
}

interface DescriptionSectionInput {
  readonly description: PromptNode
}

function section(title: string, children: PromptNode, description?: string): PromptNode {
  return jsx("section", {
    title,
    ...(description === undefined ? {} : { description }),
    children,
  })
}

function descriptiveParagraph(title: string, description: PromptNode): PromptNode {
  return section(title, jsx("p", { children: description }))
}

export function UserIntentSection(props: ContentSectionInput): PromptNode {
  return section(
    "user_profile",
    props.content,
    "A concise profile of the user's working preferences. Use it to shape your responses and suggest a next step only when it fits; do not quote or disclose the profile.",
  )
}

export function HooksAdditionalContextSection(props: ContentSectionInput): PromptNode {
  return section(
    "hooks_context",
    props.content,
    "Context and directions supplied by session hooks, which may include project-specific details or configuration.",
  )
}

export function AutomationInstructionsSection(props: ContentSectionInput): PromptNode {
  return section("automation_instructions", props.content)
}

export function AvailableSubagentModelsSection(props: DescriptionSectionInput): PromptNode {
  return descriptiveParagraph("available_subagent_models", props.description)
}

export function AvailableSubagentTypesSection(props: DescriptionSectionInput): PromptNode {
  return descriptiveParagraph("available_subagent_types", props.description)
}
