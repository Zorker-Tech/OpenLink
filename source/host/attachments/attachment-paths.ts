/**
 * Where an agent's attachments live inside its own directory.
 *
 * An agent keeps two kinds of uploaded file: the attachments a conversation brought in, and the assets an
 * agent produced. Both are folders under the agent's own directory, and the pair is what the platform treats
 * as the media store — a file outside them is not an attachment, whatever it is called.
 */

import { join } from "node:path"

export const ATTACHMENTS_DIRNAME = "attachments"
export const ASSETS_DIRNAME = "assets"

export function getAgentAttachmentsDir(agentDir: string): string {
  return join(agentDir, ATTACHMENTS_DIRNAME)
}

export function getAgentAssetsDir(agentDir: string): string {
  return join(agentDir, ASSETS_DIRNAME)
}

export function getAgentMediaStoreRoots(agentDir: string): [string, string] {
  return [getAgentAttachmentsDir(agentDir), getAgentAssetsDir(agentDir)]
}
