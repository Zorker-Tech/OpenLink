import {
  getLocalToolApprovalsPath,
  getLocalToolRetirementsPath,
  type LocalToolApproval,
} from "./local-tool-approval-contracts.ts";
import {
  readLiveLocalToolApprovals as readLive,
  readLocalToolApprovals as readAll,
} from "./local-tool-approval-files.ts";

export {
  LOCAL_TOOL_APPROVALS_FILENAME,
  LOCAL_TOOL_RETIREMENTS_FILENAME,
  getLocalToolApprovalsPath,
  getLocalToolRetirementsPath,
  parseApproval,
} from "./local-tool-approval-contracts.ts";
export {
  clearLocalToolApprovals,
  recordLocalToolApproval,
  retireLocalToolApproval,
} from "./local-tool-approval-ledger.ts";
export type { LocalToolApproval } from "./local-tool-approval-contracts.ts";

export function readLocalToolApprovals(path = getLocalToolApprovalsPath()): Promise<Map<string, LocalToolApproval>> {
  return readAll(path);
}

export function readLiveLocalToolApprovals(
  approvalsPath = getLocalToolApprovalsPath(),
  retirementsPath = getLocalToolRetirementsPath(),
): Promise<Map<string, LocalToolApproval>> {
  return readLive(approvalsPath, retirementsPath);
}
