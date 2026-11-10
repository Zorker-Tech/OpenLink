/** Build the generated subagent identity required by the Agent wire request. */

import {
  CustomSubagentPermissionMode,
  SubagentType,
  SubagentTypeCustom,
} from "../proto/generated/agent/v1/subagents_pb.ts"

export const CI_INVESTIGATOR_SUBAGENT_ID = "ci-investigator"

export function createCiInvestigatorSubagentInteropFields() {
  return {
    subagentType: new SubagentType({
      type: {
        case: "custom" as const,
        value: new SubagentTypeCustom({ name: CI_INVESTIGATOR_SUBAGENT_ID }),
      },
    }),
    permissionMode: CustomSubagentPermissionMode.AGENT_ONLY,
  }
}
