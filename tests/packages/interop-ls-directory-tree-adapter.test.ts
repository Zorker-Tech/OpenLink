import assert from "node:assert/strict"
import { test } from "node:test"

import {
  LsDirectoryTreeNode,
  LsDirectoryTreeNode_File,
  TerminalMetadata,
  TerminalMetadata_Command,
} from "../../source/adapters/interop/proto/generated/agent/v1/ls_exec_pb.ts"
import { projectLsDirectoryTree } from "../../source/adapters/interop/agent/ls-directory-tree-adapter.ts"

test("the generated listing is projected into the fields the Slate renderer consumes", () => {
  const generated = new LsDirectoryTreeNode({
    absPath: "C:\\workspace",
    childrenWereProcessed: false,
    numFiles: 2,
    fullSubtreeExtensionCounts: { ts: 1, md: 1 },
    childrenFiles: [new LsDirectoryTreeNode_File({
      name: "terminal-history",
      terminalMetadata: new TerminalMetadata({
        cwd: "C:\\workspace",
        lastModifiedMs: 10n,
        lastCommands: [new TerminalMetadata_Command({ command: "pwd", exitCode: 0 })],
        currentCommand: new TerminalMetadata_Command({ command: "build" }),
      }),
    })],
    childrenDirs: [new LsDirectoryTreeNode({ absPath: "C:\\workspace\\src", numFiles: 1 })],
  })

  assert.deepEqual(projectLsDirectoryTree(generated), {
    absPath: "C:\\workspace",
    childrenWereProcessed: false,
    numFiles: 2,
    fullSubtreeExtensionCounts: { ts: 1, md: 1 },
    childrenFiles: [{
      name: "terminal-history",
      terminalMetadata: {
        cwd: "C:\\workspace",
        lastModifiedMs: 10n,
        lastCommands: [{ command: "pwd", exitCode: 0 }],
        currentCommand: { command: "build" },
      },
    }],
    childrenDirs: [{
      absPath: "C:\\workspace\\src",
      childrenWereProcessed: false,
      numFiles: 1,
      fullSubtreeExtensionCounts: {},
      childrenFiles: [],
      childrenDirs: [],
    }],
  })
  assert.equal(projectLsDirectoryTree(undefined), undefined)
})
