import { readFile, stat } from "node:fs/promises";
import { basename, posix } from "node:path";
import { videoMimeFromPath } from "../../shared/media/image-mime.ts";
import { BOX_ATTACHMENT_STAGING_LIMIT_BYTES } from "./box-staging-contracts.ts";
import {
  BOX_ATTACHMENT_STAGING_ROOT,
  type StagedAttachmentFile,
} from "./box-staging-contracts.ts";

export function stagedAttachmentPath(hostPath: string): string {
  return posix.join(BOX_ATTACHMENT_STAGING_ROOT, basename(hostPath));
}

export function stageFileMapping(
  hostPath: string,
  bytes: Uint8Array,
): StagedAttachmentFile {
  return { boxPath: stagedAttachmentPath(hostPath), data: bytes };
}

export async function readStageableAttachment(
  hostPath: string,
  resolveOwnerDir: (path: string) => string | null,
): Promise<{ readonly hostPath: string; readonly file: StagedAttachmentFile } | undefined> {
  if (videoMimeFromPath(hostPath) !== undefined || resolveOwnerDir(hostPath) == null) {
    return undefined;
  }

  try {
    const metadata = await stat(hostPath);
    if (!metadata.isFile() || metadata.size > BOX_ATTACHMENT_STAGING_LIMIT_BYTES) return undefined;
    const file = stageFileMapping(hostPath, new Uint8Array(await readFile(hostPath)));
    return { hostPath, file };
  } catch {
    return undefined;
  }
}
