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

/** A directory of that name under the agent's own directory. */
function directoryNamed(agentRoot: string, name: string): string {
  return join(agentRoot, name)
}

export function getAgentAttachmentsDir(agentRoot: string): string {
  return directoryNamed(agentRoot, ATTACHMENTS_DIRNAME)
}

export function getAgentAssetsDir(agentRoot: string): string {
  return directoryNamed(agentRoot, ASSETS_DIRNAME)
}

export function getAgentMediaStoreRoots(agentRoot: string): [string, string] {
  return [getAgentAttachmentsDir(agentRoot), getAgentAssetsDir(agentRoot)]
}
