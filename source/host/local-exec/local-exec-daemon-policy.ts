import { readLiveLocalToolApprovals, retireLocalToolApproval } from "./local-tool-approvals.ts";
import type { LocalToolPermissionStore } from "./local-exec-daemon-run-contracts.ts";
import { readLocalExecSupervisorHeartbeat } from "./local-exec-daemon-protocol.ts";
import { SLATE_LOCAL_EXEC_SUPERVISED_WINDOW_MS } from "../../shared/local-exec-daemon.ts";
import { SLATE_LOCAL_TOOLS_DISABLED_MESSAGE, SLATE_LOCAL_TOOLS_UNAPPROVED_MESSAGE, localToolApprovalCovers } from "../../shared/local-tool-permission-machinery.ts";
import { errorLogTag } from "../../shared/errors/summary.ts";

export function createLocalExecPermissionBlocker(args: {
  readonly settings: LocalToolPermissionStore;
  readonly approvalsPath: string;
  readonly retirementsPath: string;
}) {
  return async (request: { readonly approvalId?: string; readonly describes?: Parameters<typeof localToolApprovalCovers>[1]; readonly terminalsFolder: string }): Promise<string | undefined> => {
    const permission = args.settings.getLocalToolPermission();
    if (permission === "never") return SLATE_LOCAL_TOOLS_DISABLED_MESSAGE;
    if (permission === "always") return undefined;
    if (request.approvalId == null || request.approvalId.length === 0 || request.describes == null) return SLATE_LOCAL_TOOLS_UNAPPROVED_MESSAGE;

    const approval = (await readLiveLocalToolApprovals(args.approvalsPath, args.retirementsPath)).get(request.approvalId);
    if (approval == null) return SLATE_LOCAL_TOOLS_UNAPPROVED_MESSAGE;
    const coverage = {
      ...approval,
      ...(approval.action === "run-command" ? { resourcePath: request.terminalsFolder } : {}),
    };
    return localToolApprovalCovers(coverage, request.describes) ? undefined : SLATE_LOCAL_TOOLS_UNAPPROVED_MESSAGE;
  };
}

export async function isLocalExecDaemonSupervised(heartbeatPath: string, now: () => number): Promise<boolean> {
  const heartbeat = await readLocalExecSupervisorHeartbeat(heartbeatPath);
  return now() - heartbeat.at <= SLATE_LOCAL_EXEC_SUPERVISED_WINDOW_MS;
}

export async function retireDaemonApproval(approvalId: string, approvalsPath: string, retirementsPath: string): Promise<void> {
  await retireLocalToolApproval(approvalId, approvalsPath, retirementsPath).catch((error) => {
    console.error(`[local-exec-daemon] failed to retire approval ${approvalId}: ${errorLogTag(error)}`);
  });
}
