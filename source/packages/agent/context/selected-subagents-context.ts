export interface SubagentNamePromptInput {
  readonly name: string
}

export interface SelectedSubagentsTextContent {
  readonly type: "text"
  readonly text: string
}

export function renderSelectedSubagentDelegation(
  subagents: readonly SubagentNamePromptInput[],
): SelectedSubagentsTextContent | undefined {
  if (subagents.length === 0) return undefined

  const names = subagents.map(subagent => subagent.name).join(", ")
  const firstName = subagents[0]?.name
  return {
    type: "text",
    text: `<subagent_delegation_context>\nUser requested delegation to these agents: ${names}\n\nStart a delegated task with the Task tool and set subagent_type to the desired name. Example:\nTask(subagent_type="${firstName}", prompt="Describe the delegated task here")\n</subagent_delegation_context>\n`,
  }
}
