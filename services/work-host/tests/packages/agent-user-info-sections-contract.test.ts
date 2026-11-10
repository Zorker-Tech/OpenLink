import assert from "node:assert/strict"
import test from "node:test"
import { renderContent } from "../../source/packages/prompt-jsx/index.ts"
import {
  formatMetaAgentNotesDirectoryInstruction,
  MetaAgentProjectNotesDirectorySection,
} from "../../source/packages/agent/prompts/user-info-notes-section.ts"
import {
  AutomationInstructionsSection,
  AvailableSubagentModelsSection,
  AvailableSubagentTypesSection,
  HooksAdditionalContextSection,
  UserIntentSection,
} from "../../source/packages/agent/prompts/user-info-sections.ts"

test("the notes handoff is durable, organized and pointed out to the user", () => {
  const directory = "/repo/.slate/notes"
  const instruction = formatMetaAgentNotesDirectoryInstruction(directory)

  assert.match(instruction, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.match(instruction, /existing note/i)
  assert.match(instruction, /update a relevant existing note/i)
  assert.match(instruction, /descriptive filenames/i)
  assert.match(instruction, /design or behavior/i)
  assert.match(instruction, /tell the user which files/i)
})

test("auxiliary sections keep their stable tags and explain how to use their content", () => {
  const userIntent = renderContent(UserIntentSection({ content: "writing preferences" }))
  const hooks = renderContent(HooksAdditionalContextSection({ content: "project directions" }))
  const automation = renderContent(AutomationInstructionsSection({ content: "run this" }))
  const projectNotes = renderContent(MetaAgentProjectNotesDirectorySection({ notesDirectory: "/repo/notes" }))
  const models = renderContent(AvailableSubagentModelsSection({ description: "models" }))
  const types = renderContent(AvailableSubagentTypesSection({ description: "types" }))

  assert.match(userIntent, /user_profile/)
  assert.match(userIntent, /do not quote or disclose/i)
  assert.match(userIntent, /writing preferences/)
  assert.match(hooks, /hooks_context/)
  assert.match(hooks, /session hooks/)
  assert.match(hooks, /project/i)
  assert.match(automation, /automation_instructions/)
  assert.match(automation, /run this/)
  assert.match(projectNotes, /project_notes_directory/)
  assert.match(projectNotes, /repo\/notes/)
  assert.match(models, /available_subagent_models/)
  assert.match(models, /models/)
  assert.match(types, /available_subagent_types/)
  assert.match(types, /types/)
})
