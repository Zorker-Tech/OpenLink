import {
  getLocalToolApprovalsPath,
  getLocalToolRetirementsPath,
  type LocalToolApproval,
} from "./local-tool-approval-contracts.ts";
import {
  readLocalToolApprovals,
  readRetiredApprovalIds,
  writeApprovals,
  writeRetiredApprovalIds,
} from "./local-tool-approval-files.ts";
import { inPathOrder } from "./local-tool-approval-write-lane.ts";

export async function recordLocalToolApproval(
  approval: LocalToolApproval,
  path = getLocalToolApprovalsPath(),
): Promise<void> {
  await inPathOrder(path, async () => {
    const next = new Map(await readLocalToolApprovals(path));
    next.set(approval.id, approval);
    await writeApprovals(path, next);
  });
}

export async function clearLocalToolApprovals(path = getLocalToolApprovalsPath()): Promise<void> {
  await inPathOrder(path, async () => writeApprovals(path, new Map()));
}

export async function retireLocalToolApproval(
  approvalId: string,
  approvalsPath = getLocalToolApprovalsPath(),
  retirementsPath = getLocalToolRetirementsPath(),
): Promise<void> {
  await inPathOrder(retirementsPath, async () => {
    const approvals = await readLocalToolApprovals(approvalsPath);
    const retired = await readRetiredApprovalIds(retirementsPath);
    if (retired.has(approvalId)) return;

    retired.add(approvalId);
    for (const id of retired) {
      if (!approvals.has(id)) retired.delete(id);
    }
    await writeRetiredApprovalIds(retirementsPath, retired);
  });
}
