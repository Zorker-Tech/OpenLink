/**
 * The images a cloud agent is shown.
 *
 * An image reaches a cloud agent as a file: one under the user's own attachments or assets, or one under /workspace in
 * the box. Everything else is answered with the reason — a url that is not a file url, a file that is not an image, a
 * path outside both places, an image too large to send, or one that cannot be read — so a caller learns what to change
 * instead of getting an agent that saw nothing.
 */

import { readFile, stat } from "node:fs/promises";
import { posix } from "node:path";
import { ATTACHMENT_BYTE_LIMIT, formatAttachmentTooLargeNotice } from "../../shared/media/attachment-limits.ts";
import { imageMimeFromPath } from "../../shared/media/image-mime.ts";
import { containWithin, filePathFromFileUrl, posixPathFromFileUrl } from "../../shared/node/paths.ts";
import { getAgentMediaStoreRoots } from "../attachments/attachment-paths.ts";

export const SLATE_BOX_WORKSPACE_ROOT = "/workspace";

export interface CloudAgentImage {
  readonly data: Uint8Array;
  readonly path: string;
  readonly mimeType: string;
}

/** What became of one image, before it is turned into the message a caller reads. */
type ImageLoad = { kind: "loaded"; image: CloudAgentImage } | { kind: "unreadable" | "refused" | "too-large" };

/** One image, from the place it lives: the user's own store first, the box's workspace next. */
async function loadCloudAgentImage<Context>(args: {
  ctx: Context;
  hostPath: string | null;
  mediaStoreRoots: readonly string[];
  boxPath: string;
  mimeType: string;
  readBoxFile?: (ctx: Context, path: string) => Promise<Uint8Array>;
}): Promise<ImageLoad> {
  const contained = args.hostPath == null ? null : await containWithin(args.mediaStoreRoots, args.hostPath);
  if (contained != null) {
    let info;
    try {
      info = await stat(contained);
    } catch {
      return { kind: "unreadable" };
    }
    // A directory is not a file a cloud agent can be shown.
    if (!info.isFile()) return { kind: "unreadable" };
    if (info.size > ATTACHMENT_BYTE_LIMIT) return { kind: "too-large" };
    try {
      return { kind: "loaded", image: { data: new Uint8Array(await readFile(contained)), path: contained, mimeType: args.mimeType } };
    } catch {
      return { kind: "unreadable" };
    }
  }
  // Anything outside those two places is refused rather than read.
  const underWorkspace = args.boxPath === SLATE_BOX_WORKSPACE_ROOT || args.boxPath.startsWith(`${SLATE_BOX_WORKSPACE_ROOT}/`);
  if (!underWorkspace) return { kind: "refused" };
  if (args.readBoxFile == null) return { kind: "unreadable" };
  try {
    const data = await args.readBoxFile(args.ctx, args.boxPath);
    return data.byteLength > ATTACHMENT_BYTE_LIMIT ? { kind: "too-large" } : { kind: "loaded", image: { data, path: args.boxPath, mimeType: args.mimeType } };
  } catch {
    return { kind: "unreadable" };
  }
}

export async function loadCloudAgentImages<Context>(args: {
  readonly ctx: Context;
  readonly urls: readonly string[];
  readonly agentDir: string;
  readonly readBoxFile?: (ctx: Context, path: string) => Promise<Uint8Array>;
}): Promise<{ ok: true; images: CloudAgentImage[] } | { ok: false; message: string }> {
  const mediaStoreRoots = getAgentMediaStoreRoots(args.agentDir);
  const images: CloudAgentImage[] = [];
  for (const url of args.urls) {
    const rawBoxPath = posixPathFromFileUrl(url);
    const boxPath = rawBoxPath == null ? null : posix.normalize(rawBoxPath);
    if (boxPath == null) {
      return { ok: false, message: `'${url}' is not a file:// url. Attach an image the cloud agent can be shown by passing an absolute file:// path (a path in your box like file:///workspace/shot.png, or one in your own attachments/assets folder). An https:// image has to be downloaded to a file first.` };
    }
    const mimeType = imageMimeFromPath(boxPath);
    if (mimeType == null) {
      return { ok: false, message: `'${url}' is not a recognized image (png, jpeg, gif, webp, …). Only images ride the cloud agent's vision channel; point a non-image file out in the prompt instead.` };
    }
    const loaded = await loadCloudAgentImage({
      ctx: args.ctx,
      hostPath: filePathFromFileUrl(url),
      mediaStoreRoots,
      boxPath,
      mimeType,
      ...(args.readBoxFile === undefined ? {} : { readBoxFile: args.readBoxFile }),
    });
    if (loaded.kind === "loaded") images.push(loaded.image);
    else if (loaded.kind === "unreadable") return { ok: false, message: `Could not read the image at '${url}'. The path is one you're allowed to read, so check it actually exists.` };
    else if (loaded.kind === "refused") return { ok: false, message: `Refused to read '${url}': it is neither inside your own attachments/assets folder nor under /workspace in your box. Copy the image into /workspace first, then attach it from there.` };
    else return { ok: false, message: formatAttachmentTooLargeNotice(url) };
  }
  return { ok: true, images };
}
