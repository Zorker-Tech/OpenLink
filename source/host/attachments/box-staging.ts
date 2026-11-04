/**
 * Staging an attachment for a box.
 *
 * The bytes are written into the box's staging directory under a name the caller can ask for again, bounded by the
 * attachment limit, and what was staged is removed when the caller is done with it.
 */
import type { BoxAttachmentStagingPorts } from "./box-staging-contracts.ts";
import { readStageableAttachment } from "./box-staging-policy.ts";

export {
  BOX_ATTACHMENT_STAGING_LIMIT_BYTES,
  BOX_ATTACHMENT_STAGING_ROOT,
} from "./box-staging-contracts.ts";
export type { BoxAttachmentStagingPorts } from "./box-staging-contracts.ts";

export async function stageAttachmentsForAgent<Context>(
  deps: BoxAttachmentStagingPorts<Context>,
  agentId: string,
  hostPaths: readonly string[],
): Promise<Map<string, string>> {
  const staged = new Map<string, string>();
  if (hostPaths.length === 0) return staged;
  try { if (await deps.box.runState(deps.ctx, agentId) !== "running") return staged; } catch { return staged; }
  const filesToTransfer = [];
  for (const hostPath of hostPaths) {
    const prepared = await readStageableAttachment(hostPath, deps.resolveOwnerDir);
    if (prepared === undefined) continue;
    filesToTransfer.push(prepared.file);
    staged.set(prepared.hostPath, prepared.file.boxPath);
  }
  if (filesToTransfer.length === 0) return staged;
  try { await deps.upload(deps.ctx, deps.box, agentId, filesToTransfer); } catch { return new Map(); }
  return staged;
}
