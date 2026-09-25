/**
 * The smaller sections of the first user message.
 *
 * The context block is a list of named sections, and most of them are a paragraph the platform wrote
 * about the session it is in. Each is a section rather than loose text because the renderer turns the
 * section title into a tag, and the tag is what the rest of the platform — and the agent — looks for
 * when it decides whether the block is still current.
 *
 * The notes instruction is the one that is not about the session: it tells a meta agent where to write
 * notes for whoever works on the same problem next, and how to keep them navigable.
 */

import { jsx, type PromptNode } from "../../prompt-jsx/index.ts"

export function formatMetaAgentNotesDirectoryInstruction(notesDirectory: string): string {
  return `Write notes which may be useful for other agents working on the same problem to the ${notesDirectory}. If relevant note files already exist, read them and consider extending them.

Use informatively named files to make the notes easily navigable. Group notes about similar concepts underneath the same directories. Focus on information related to the design or functionality of the system which is likely to be helpful to other agents in the future.

If you write to note file(s), reference the key note(s) in your responses to the user.`
}

export function UserIntentSection(props: { readonly content: PromptNode }): PromptNode {
  return jsx("section", {
    title: "user_profile",
    description: "Summary of the user's work style and preferences. DO NOT mention this information in your responses, but use it to guide your responses and behavior when interacting with the user, and suggest next steps to the user if there is a matching workflow in the profile.",
    children: props.content,
  })
}

export function HooksAdditionalContextSection(props: { readonly content: PromptNode }): PromptNode {
  return jsx("section", {
    title: "hooks_context",
    description: "Additional context provided by session hooks. This may include project-specific information, configuration, or instructions from the user's hooks setup.",
    children: props.content,
  })
}

export function AutomationInstructionsSection(props: { readonly content: PromptNode }): PromptNode {
  return jsx("section", { title: "automation_instructions", children: props.content })
}

export function MetaAgentProjectNotesDirectorySection(props: { readonly notesDirectory: string }): PromptNode {
  return jsx("section", {
    title: "project_notes_directory",
    children: formatMetaAgentNotesDirectoryInstruction(props.notesDirectory),
  })
}

/** The subagent models this session can reach. Rendered by the rerender check as well as by the block. */
export function AvailableSubagentModelsSection(props: { readonly description: PromptNode }): PromptNode {
  return jsx("section", {
    title: "available_subagent_models",
    children: jsx("p", { children: props.description }),
  })
}

/** The subagent types this session can reach, and when to use each. */
export function AvailableSubagentTypesSection(props: { readonly description: PromptNode }): PromptNode {
  return jsx("section", {
    title: "available_subagent_types",
    children: jsx("p", { children: props.description }),
  })
}
