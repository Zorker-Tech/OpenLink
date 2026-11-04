/** Loads only image files the cloud agent is allowed to receive. */

import { readFile, stat } from "node:fs/promises"
import { posix } from "node:path"
import { ATTACHMENT_BYTE_LIMIT, formatAttachmentTooLargeNotice } from "../../shared/media/attachment-limits.ts"
import { imageMimeFromPath } from "../../shared/media/image-mime.ts"
import { containWithin, filePathFromFileUrl, posixPathFromFileUrl } from "../../shared/node/paths.ts"
import { getAgentMediaStoreRoots } from "../attachments/attachment-paths.ts"

export const SLATE_BOX_WORKSPACE_ROOT = "/workspace"

export interface CloudAgentImage {
  readonly data: Uint8Array
  readonly path: string
  readonly mimeType: string
}

type ImageReadOutcome =
  | { readonly status: "ready"; readonly image: CloudAgentImage }
  | { readonly status: "unavailable" | "unpermitted" | "oversized" }

type HostAttachmentRead =
  | { readonly status: "miss" }
  | { readonly status: "resolved"; readonly result: ImageReadOutcome }

async function readHostAttachment(
  context: unknown,
  path: string | null,
  roots: readonly string[],
  mimeType: string,
): Promise<HostAttachmentRead> {
  if (path == null) return { status: "miss" }
  const containedPath = await containWithin(roots, path)
  if (containedPath == null) return { status: "miss" }

  let details
  try {
    details = await stat(containedPath)
  } catch {
    return { status: "resolved", result: { status: "unavailable" } }
  }
  if (!details.isFile()) return { status: "resolved", result: { status: "unavailable" } }
  if (details.size > ATTACHMENT_BYTE_LIMIT) return { status: "resolved", result: { status: "oversized" } }

  try {
    const data = new Uint8Array(await readFile(containedPath))
    return { status: "resolved", result: { status: "ready", image: { data, path: containedPath, mimeType } } }
  } catch {
    return { status: "resolved", result: { status: "unavailable" } }
  }
}

function belongsToBoxWorkspace(path: string): boolean {
  return path === SLATE_BOX_WORKSPACE_ROOT || path.startsWith(`${SLATE_BOX_WORKSPACE_ROOT}/`)
}

async function readBoxImage<Context>(args: {
  readonly context: Context
  readonly path: string
  readonly mimeType: string
  readonly readBoxFile?: ((context: Context, path: string) => Promise<Uint8Array>) | undefined
}): Promise<ImageReadOutcome> {
  if (!belongsToBoxWorkspace(args.path)) return { status: "unpermitted" }
  if (args.readBoxFile == null) return { status: "unavailable" }

  try {
    const data = await args.readBoxFile(args.context, args.path)
    return data.byteLength > ATTACHMENT_BYTE_LIMIT
      ? { status: "oversized" }
      : { status: "ready", image: { data, path: args.path, mimeType: args.mimeType } }
  } catch {
    return { status: "unavailable" }
  }
}

async function resolveImageSource<Context>(args: {
  readonly context: Context
  readonly hostPath: string | null
  readonly boxPath: string
  readonly roots: readonly string[]
  readonly mimeType: string
  readonly readBoxFile?: ((context: Context, path: string) => Promise<Uint8Array>) | undefined
}): Promise<ImageReadOutcome> {
  const hostRead = await readHostAttachment(args.context, args.hostPath, args.roots, args.mimeType)
  if (hostRead.status === "resolved") return hostRead.result
  return readBoxImage({
    context: args.context,
    path: args.boxPath,
    mimeType: args.mimeType,
    readBoxFile: args.readBoxFile,
  })
}

function imageRefusal(url: string, outcome: ImageReadOutcome): string {
  if (outcome.status === "unavailable") {
    return `The image at '${url}' could not be read. Confirm the file exists and is available under an allowed image path.`
  }
  if (outcome.status === "unpermitted") {
    return `The image at '${url}' is outside the allowed attachment locations. Put it in the agent's attachments/assets or the box workspace (/workspace), then retry.`
  }
  return formatAttachmentTooLargeNotice(url)
}

export async function loadCloudAgentImages<Context>(args: {
  readonly ctx: Context
  readonly urls: readonly string[]
  readonly agentDir: string
  readonly readBoxFile?: (ctx: Context, path: string) => Promise<Uint8Array>
}): Promise<{ ok: true; images: CloudAgentImage[] } | { ok: false; message: string }> {
  const mediaRoots = getAgentMediaStoreRoots(args.agentDir)
  const images: CloudAgentImage[] = []

  for (const url of args.urls) {
    const rawBoxPath = posixPathFromFileUrl(url)
    const boxPath = rawBoxPath == null ? null : posix.normalize(rawBoxPath)
    if (boxPath == null) {
      return { ok: false, message: `'${url}' is not a file:// url. Attach an image a cloud agent can read by passing an absolute file:// path in your box or attachments/assets folder. Download https:// images to a file first.` }
    }

    const mimeType = imageMimeFromPath(boxPath)
    if (mimeType == null) {
      return { ok: false, message: `'${url}' is not a recognized image (png, jpeg, gif, webp, …). Only images can be attached to a cloud agent; refer to a non-image file in the prompt instead.` }
    }

    const outcome = await resolveImageSource({
      context: args.ctx,
      hostPath: filePathFromFileUrl(url),
      boxPath,
      roots: mediaRoots,
      mimeType,
      ...(args.readBoxFile === undefined ? {} : { readBoxFile: args.readBoxFile }),
    })
    if (outcome.status === "ready") images.push(outcome.image)
    else return { ok: false, message: imageRefusal(url, outcome) }
  }

  return { ok: true, images }
}
