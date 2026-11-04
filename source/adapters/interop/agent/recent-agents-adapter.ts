import type { RecentAgent } from "../proto/generated/agent/v1/selected_context_pb.ts";
import type { RecentAgentPromptInput } from "../../../packages/agent/context/recent-agents-context.ts";

export function toRecentAgentPromptInputs(agents: readonly RecentAgent[]): RecentAgentPromptInput[] {
  return agents.map(agent => ({
    name: agent.name,
    path: agent.path,
    ...(agent.overview === undefined ? {} : { overview: agent.overview }),
  }));
}
