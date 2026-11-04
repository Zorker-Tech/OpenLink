import { ConversationStateStructure } from "../proto/generated/agent/v1/agent_pb.ts";
import type { SubagentType } from "../proto/generated/agent/v1/subagents_pb.ts";
import {
  isVideoReviewSubagentType,
  slateSubagentTypeName,
} from "../../../packages/agent/subagent-type.ts";
import {
  mapSubagentConversationState as mapSlateSubagentConversationState,
  type ConversationStateMappingPort as SlateConversationStateMappingPort,
} from "../../../packages/agent/subagent-conversation-state.ts";

export type CounterpartSubagentType = SubagentType;
export type ConversationStateMapperInterop = (
  callerState: ConversationStateStructure,
) => ConversationStateStructure;

export function subagentTypeNameFromInterop(value: CounterpartSubagentType): string {
  return slateSubagentTypeName(value)
}

export { isVideoReviewSubagentType }

export interface ConversationStateMappingPort
  extends SlateConversationStateMappingPort {
  readonly conversationStateMapper?: ConversationStateMapperInterop | undefined;
}

export function mapSubagentConversationState(
  config: ConversationStateMappingPort,
  callerState: ConversationStateStructure,
): ConversationStateStructure {
  return mapSlateSubagentConversationState(
    config,
    callerState,
    new ConversationStateStructure(),
  )
}
