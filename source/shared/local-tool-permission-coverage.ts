import type { SlateLocalToolApproval, SlateLocalToolRequest } from "./local-tool-permission-contracts.ts";
import { normalizeLocalToolResourcePath } from "./local-tool-permission-requests.ts";

function sameResource(approval: SlateLocalToolApproval, request: SlateLocalToolRequest): boolean {
  const ownedPath = normalizeLocalToolResourcePath(approval.resourcePath);
  const attachedPath = normalizeLocalToolResourcePath(request.attachToResourcePath);
  return ownedPath !== undefined && ownedPath === attachedPath;
}

export function localToolApprovalCovers(approval: SlateLocalToolApproval, request: SlateLocalToolRequest): boolean {
  const sameAction = approval.action === request.action;
  const sameTarget = approval.target === request.target;
  return (sameAction && sameTarget) || sameResource(approval, request);
}
