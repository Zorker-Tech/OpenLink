import path from "node:path";

import { isBoxRootPath } from "../../boxes/box-transfer.ts";
import { imageMimeFromPath } from "../../../shared/media/image-mime.ts";
import type { BoxMediaAttachmentRequest } from "./send-message-encoding-contracts.ts";

export async function resolveBoxMediaAttachment(request: BoxMediaAttachmentRequest): Promise<string | null> {
  if (!request.remoteBoxHasDesktop || !isBoxRootPath(request.boxPath)) return null;

  try {
    const contents = await request.download(request.boxPath);
    if (contents === null) return null;
    const imageMime = imageMimeFromPath(request.boxPath);
    if (imageMime != null) return (await request.persistImage?.(contents, imageMime))?.fileUrl ?? null;
    const fileName = path.basename(request.boxPath);
    return await request.persistMediaBytes?.(fileName, contents) ?? null;
  } catch {
    return null;
  }
}
