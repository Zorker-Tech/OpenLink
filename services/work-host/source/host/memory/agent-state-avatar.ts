/** Validates and installs the local avatar image exposed by agent self-state. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { isBoxRootPath } from "../boxes/box-transfer.ts";
import { CANONICAL_AVATAR_FILENAME, invalidateAvatarDataUrlCache, listConventionalAvatarFilenames, sniffAvatarMimeType } from "../agents/agent-avatar.ts";
import { AVATAR_MAX_BYTES, isBlankAgentText, stateWriteFailed, stateWriteOk, type AgentStateDeps } from "./agent-state-contracts.ts";

function fileExtensionFor(mime: string): string | null {
  const extensions: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
  };
  return extensions[mime] ?? null;
}

export function createAgentAvatarOperations(deps: AgentStateDeps) {
  return {
    async setAvatar(args: { path: string }) {
      if (isBlankAgentText(args.path)) return stateWriteFailed("pass the path of an image file to install.");
      const path = args.path.trim();
      const absolutePath = isAbsolute(path) ? path : resolve(path);
      let content: Uint8Array | null = null;
      try {
        content = await readFile(absolutePath);
      } catch {
        if (deps.readBoxFile !== undefined && isBoxRootPath(absolutePath)) {
          try { content = await deps.readBoxFile(absolutePath); } catch { /* A box read may race with a cleaned file. */ }
        }
      }

      if (content === null) {
        const location = isBoxRootPath(absolutePath)
          ? `could not read "${basename(absolutePath)}" from your box — write the image with Shell (or CopyFromBox onto a host path) first, then pass that path.`
          : `could not read "${basename(absolutePath)}" — download or write the image somewhere first, then pass that path.`;
        return stateWriteFailed(location);
      }
      if (content.byteLength === 0 || content.byteLength > AVATAR_MAX_BYTES) {
        return stateWriteFailed(`the image must be under ${AVATAR_MAX_BYTES / (1024 * 1024)} MB and non-empty.`);
      }

      const mime = sniffAvatarMimeType(content);
      const extension = mime === null ? null : fileExtensionFor(mime);
      if (extension === null) return stateWriteFailed("that file is not a recognized image (png, jpg, webp, gif, or svg).");

      await mkdir(deps.agentDir, { recursive: true });
      for (const oldName of listConventionalAvatarFilenames(deps.agentDir)) await rm(join(deps.agentDir, oldName), { force: true });
      const fileName = extension === "png" ? CANONICAL_AVATAR_FILENAME : `avatar.${extension}`;
      await writeFile(join(deps.agentDir, fileName), content);
      invalidateAvatarDataUrlCache(deps.agentDir);
      deps.onAvatarChanged?.();
      return stateWriteOk(`Updated your picture (${fileName}). Source ${basename(absolutePath)} can be deleted if you no longer need it.`);
    },

    async clearAvatar() {
      const files = listConventionalAvatarFilenames(deps.agentDir);
      if (files.length === 0) return stateWriteFailed("you already have the default picture.");
      for (const fileName of files) await rm(join(deps.agentDir, fileName), { force: true });
      invalidateAvatarDataUrlCache(deps.agentDir);
      deps.onAvatarChanged?.();
      return stateWriteOk("Cleared your picture — back to the default.");
    },
  };
}
