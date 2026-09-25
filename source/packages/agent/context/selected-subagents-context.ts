/**
 * The subagents the user asked for by name.
 *
 * A user can point at the subagents they want the work delegated to, and the agent has to be told both
 * which ones and how to reach them — the tool, the parameter, and a worked example — because the
 * instruction "delegate to these" is otherwise ambiguous about the mechanism.
 */

import type { SelectedSubagent } from "../../proto/generated/agent/v1/selected_context_pb.ts"

export interface SelectedSubagentsTextContent {
  readonly type: "text"
  readonly text: string
}

export function renderSelectedSubagentDelegation(
  selectedSubagents: readonly SelectedSubagent[],
): SelectedSubagentsTextContent | undefined {
  if (selectedSubagents.length === 0) return undefined
  const subagentNames = selectedSubagents.map(subagent => subagent.name).join(", ")
  return {
    type: "text",
    text: `<subagent_delegation_context>
The user has indicated they want you to delegate work to the following subagent(s): ${subagentNames}

To delegate, call the Task tool with the subagent_type parameter. Example:
Task(subagent_type="${selectedSubagents[0]?.name}", prompt="your detailed task description")
</subagent_delegation_context>
`,
  }
}
