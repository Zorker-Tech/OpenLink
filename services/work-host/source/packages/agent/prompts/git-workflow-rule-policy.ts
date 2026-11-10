/** Decide whether a user-facing turn needs the Git workflow rules. */

import { AgentType } from "../utils/agent-config.ts";

export interface GitWorkflowModelCapability {
  readonly needsGitWorkflowRules: boolean;
}

export function shouldInjectGitWorkflowRules(
  capability: GitWorkflowModelCapability | undefined,
  agentType?: AgentType,
): boolean {
  return capability?.needsGitWorkflowRules === true && agentType !== AgentType.BACKGROUND;
}
