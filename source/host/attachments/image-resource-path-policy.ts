import { getAgentAssetsDir, getAgentMediaStoreRoots } from "./attachment-paths.ts";
import { containWithin } from "../../shared/node/paths.ts";

export function generatedImageTarget(agentDirectory: string, requestedPath: string): Promise<string | null> {
  return containWithin([getAgentAssetsDir(agentDirectory)], requestedPath);
}

export function referenceImageTarget(agentDirectory: string, requestedPath: string): Promise<string | null> {
  return containWithin(getAgentMediaStoreRoots(agentDirectory), requestedPath);
}
