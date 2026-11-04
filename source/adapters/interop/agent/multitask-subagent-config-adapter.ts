/** Encodes Slate's executor-worker definition as the generated host subagent type. */

import { SubagentType, SubagentTypeCustom } from "../proto/generated/agent/v1/subagents_pb.ts"
import type { SlateExecutorSubagentDefinition } from "../../../host/slate-multitask.ts"

export function encodeSlateExecutorSubagentConfig(definition: SlateExecutorSubagentDefinition) {
  return {
    subagent_type: new SubagentType({
      type: {
        case: "custom",
        value: new SubagentTypeCustom({ name: definition.typeName }),
      },
    }),
    description: definition.description,
    preserveTaskTool: definition.preserveTaskTool,
    subagentSource: definition.subagentSource,
  }
}
