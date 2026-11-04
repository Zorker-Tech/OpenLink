import { SimulatedMsgReason } from "../proto/generated/agent/v1/agent_pb.ts";
import type { MultitaskActionKind } from "../../../packages/agent/multitask-action-prompt.ts";

export function multitaskActionForReason(
  reason: SimulatedMsgReason,
): MultitaskActionKind | undefined {
  if (reason === SimulatedMsgReason.MULTITASK) return "start-self-fork";
  if (reason === SimulatedMsgReason.BUILD_IN_PARALLEL) return "execute-plan-in-parallel";
  return undefined;
}
