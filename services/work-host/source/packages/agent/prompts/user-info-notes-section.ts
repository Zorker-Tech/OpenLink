/** Guidance and section wrapper for durable notes left for a future agent. */
import { jsx, type PromptNode } from "../../prompt-jsx/index.ts"

export function formatMetaAgentNotesDirectoryInstruction(notesDirectory: string): string {
  return `Record durable handoff notes in ${notesDirectory}. Review the directory before adding a file, and update a relevant existing note when that is a good fit.

Choose descriptive filenames and keep related topics together. Prioritize reusable facts about the system's design or behavior over details that will soon expire.

When you add notes, tell the user which files matter.`
}

export function MetaAgentProjectNotesDirectorySection(props: { readonly notesDirectory: string }): PromptNode {
  return jsx("section", {
    title: "project_notes_directory",
    children: formatMetaAgentNotesDirectoryInstruction(props.notesDirectory),
  })
}
