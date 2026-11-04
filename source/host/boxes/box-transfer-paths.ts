import { posix } from "node:path";
import { BOX_PATH_ROOTS, SLATE_BOX_WORKSPACE_ROOT } from "./box-transfer-contracts.ts";

/** Check path membership against a box root using a segment boundary. */
export function isBoxRootPath(path: string): boolean {
  return BOX_PATH_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

/** Resolve relative workspace names while leaving absolute box paths rooted as provided. */
export function resolveBoxWorkspacePath(boxPath: string): string {
  if (posix.isAbsolute(boxPath)) return posix.normalize(boxPath);
  return posix.join(SLATE_BOX_WORKSPACE_ROOT, boxPath);
}
