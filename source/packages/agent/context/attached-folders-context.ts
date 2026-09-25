/**
 * The folders the user attached, shown as trees.
 *
 * A folder is attached for its shape rather than its contents: the tree says what is in there and how it
 * is organised, and the agent reads the files it decides matter. Each tree is rendered within its own
 * budget — an attached folder should not be able to take over the message — and a folder that was
 * attached without a tree is skipped rather than shown empty, since a path alone says nothing.
 */

import type { LsDirectoryTreeNode } from "../../proto/generated/agent/v1/ls_exec_pb.ts"
import { renderDirectoryTreeWithinBudget } from "../tools/core/ls/formatters.ts"

export interface SelectedFolderForPrompt {
  readonly path: string
  readonly directoryTree?: LsDirectoryTreeNode | undefined
}

export function renderAttachedFoldersContext(folders: readonly SelectedFolderForPrompt[]): string | undefined {
  if (folders.length === 0) return undefined
  const folderContents: string[] = []
  for (const folder of folders) {
    if (!folder.directoryTree) continue
    const formattedTree = renderDirectoryTreeWithinBudget(folder.directoryTree)
    folderContents.push(`Folder: ${folder.path}
Contents of directory:
${formattedTree.result}`)
  }
  if (folderContents.length === 0) return undefined
  return `<attached_folders>
Here are some folder${folders.length > 1 ? "s" : ""} I manually attached to my message:

${folderContents.join("\n\n")}
</attached_folders>`
}
