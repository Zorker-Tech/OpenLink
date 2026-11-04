/** Locate and inspect the one-at-a-time claim used by agent-store mutations. */
import * as path from "node:path";
import { AGENT_STORE_SYNC_DIR_NAME } from "./paths.ts";
import { readActiveStoreLockOwner, type StoreLockOwner } from "./store-lock.ts";

const MUTATION_LOCK_FILE_NAME = "exclusive-mutation.lock";

export function resolveAgentStoreMutationLockPath(filesDirectory: string): string {
  const storeRoot = path.dirname(path.resolve(filesDirectory));
  return path.join(storeRoot, AGENT_STORE_SYNC_DIR_NAME, MUTATION_LOCK_FILE_NAME);
}

export function readCurrentAgentStoreMutationOwner(args: { readonly filesDirectory: string }): Promise<StoreLockOwner | undefined> {
  return readActiveStoreLockOwner({ lockPath: resolveAgentStoreMutationLockPath(args.filesDirectory) });
}
