import type { TransferBox } from "../boxes/box-transfer.ts";

export const BOX_ATTACHMENT_STAGING_LIMIT_BYTES = 50 * 1024 * 1024;
export const BOX_ATTACHMENT_STAGING_ROOT = "/workspace/uploads";

export interface StagedAttachmentFile {
  readonly boxPath: string;
  readonly data: Uint8Array;
}

export interface BoxAttachmentStagingPorts<Context> {
  readonly ctx: Context;
  readonly box: TransferBox & { runState(ctx: Context, agentId: string): Promise<string> };
  readonly resolveOwnerDir: (path: string) => string | null;
  readonly upload: (
    ctx: Context,
    box: BoxAttachmentStagingPorts<Context>["box"],
    agentId: string,
    files: readonly StagedAttachmentFile[],
  ) => Promise<void>;
}
