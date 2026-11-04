import type { SelectedSubagent } from "../proto/generated/agent/v1/selected_context_pb.ts";
import type { SubagentNamePromptInput } from "../../../packages/agent/context/selected-subagents-context.ts";

export function toSubagentNameInputs(
  subagents: readonly SelectedSubagent[],
): SubagentNamePromptInput[] {
  return subagents.map(subagent => ({ name: subagent.name }));
}
