import type { RequestContext } from "../proto/generated/agent/v1/request_context_exec_pb.ts";
import {
  resolveSmartModeAutoRunInstructions,
  type AutoRunPolicyInstructions,
  type SmartModeAutoRunInstructions,
} from "../../../packages/agent/utils/permissions-instructions.ts";

export type SmartModePermissionRequestContext = Pick<
  RequestContext,
  "userPermissionsAutoRun" | "projectPermissionsAutoRun" | "adminPermissionsAutoRun"
>;

type RequestInstructions = NonNullable<RequestContext["userPermissionsAutoRun"]>;

function toPolicyInstructions(value: RequestInstructions | undefined): AutoRunPolicyInstructions | undefined {
  if (value === undefined) return undefined;
  return {
    allowInstructions: value.allowInstructions,
    blockInstructions: value.blockInstructions,
  };
}

/** Project the request's ownership-tagged fields into Slate's user, project and administrator policy layers. */
export function smartModeAutoRunInstructionsFromRequestContext(
  request: SmartModePermissionRequestContext,
): SmartModeAutoRunInstructions {
  return resolveSmartModeAutoRunInstructions({
    user: toPolicyInstructions(request.userPermissionsAutoRun),
    project: toPolicyInstructions(request.projectPermissionsAutoRun),
    administrator: toPolicyInstructions(request.adminPermissionsAutoRun),
  });
}
