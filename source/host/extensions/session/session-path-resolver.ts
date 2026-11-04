import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getSlateRootDir } from "../../host-paths.ts";
import { assertValidSlateAgentId, getSlateAgentsRootDir } from "../../storage/agent-paths.ts";
import {
  AGENT_DATABASE_FILE,
  CONNECTOR_SECRET_ROOT_FOLDER,
  TRANSCRIPT_FOLDER,
} from "./session-path-contracts.ts";

export function transcriptDirectory(homeDirectory = homedir()): string {
  return join(getSlateRootDir(homeDirectory), TRANSCRIPT_FOLDER);
}

export function agentDatabasePath(rootDirectory: string, agentId: string): string {
  assertValidSlateAgentId(agentId);
  return join(rootDirectory, agentId, AGENT_DATABASE_FILE);
}

export function connectorSecretDirectory(
  agentsRootDirectory = getSlateAgentsRootDir(),
): string {
  return join(dirname(agentsRootDirectory), CONNECTOR_SECRET_ROOT_FOLDER);
}
