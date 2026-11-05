import assert from "node:assert/strict"
import test from "node:test"

import { projectSelectedWorkspaceContext } from "../../source/adapters/interop/agent/selected-context-entry-adapter.ts"
import {
  SelectedCodeSelection,
  SelectedContext,
  SelectedFile,
  SelectedFolder,
  SelectedTerminal,
  SelectedTerminalSelection,
} from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import { Position, Range } from "../../source/adapters/interop/proto/generated/agent/v1/utils_pb.ts"

test("workspace selection fields project to Slate records without changing order or ranges", () => {
  const context = new SelectedContext({
    files: [new SelectedFile({ path: "/repo/a.ts", relativePath: "a.ts", content: "file body" })],
    codeSelections: [new SelectedCodeSelection({
      path: "/repo/b.ts",
      relativePath: "b.ts",
      content: "selected code",
      range: new Range({
        start: new Position({ line: 2, column: 3 }),
        end: new Position({ line: 8, column: 5 }),
      }),
    })],
    terminals: [new SelectedTerminal({ title: "Build", path: "/repo", content: "success" })],
    terminalSelections: [new SelectedTerminalSelection({
      title: "Test",
      path: "/repo",
      content: "failed",
      range: new Range({
        start: new Position({ line: 11, column: 1 }),
        end: new Position({ line: 14, column: 7 }),
      }),
    })],
    folders: [new SelectedFolder({
      path: "/repo/src",
      relativePath: "src",
      directoryTree: {
        absPath: "/repo/src",
        childrenDirs: [],
        childrenFiles: [{ name: "index.ts" }],
        childrenWereProcessed: true,
        numFiles: 1,
        fullSubtreeExtensionCounts: { ts: 1 },
      } as never,
    })],
  })

  assert.deepEqual(projectSelectedWorkspaceContext(context), {
    files: [{ path: "/repo/a.ts", content: "file body", relativePath: "a.ts" }],
    codeSelections: [{
      path: "/repo/b.ts",
      content: "selected code",
      range: { start: { line: 2, column: 3 }, end: { line: 8, column: 5 } },
    }],
    terminals: [{ content: "success", title: "Build", path: "/repo" }],
    terminalSelections: [{
      content: "failed",
      title: "Test",
      path: "/repo",
      range: { start: { line: 11, column: 1 }, end: { line: 14, column: 7 } },
    }],
    folders: [{
      path: "/repo/src",
      relativePath: "src",
      directoryTree: {
        absPath: "/repo/src",
        childrenWereProcessed: true,
        childrenFiles: [{ name: "index.ts" }],
        childrenDirs: [],
        numFiles: 1,
        fullSubtreeExtensionCounts: { ts: 1 },
      },
    }],
  })
})

test("empty workspace selections remain explicit empty arrays", () => {
  assert.deepEqual(projectSelectedWorkspaceContext(new SelectedContext()), {
    files: [],
    codeSelections: [],
    terminals: [],
    terminalSelections: [],
    folders: [],
  })
})

test("a malformed nested folder tree is omitted without hiding following folders", () => {
  const rawContext = {
    files: [],
    codeSelections: [],
    terminals: [],
    terminalSelections: [],
    folders: [
      {
        path: "/broken",
        directoryTree: {
          absPath: "/broken",
          childrenWereProcessed: true,
          childrenFiles: [],
          childrenDirs: [{ absPath: "/broken/subdir", childrenFiles: [], childrenDirs: null }],
          numFiles: 0,
          fullSubtreeExtensionCounts: {},
        } as never,
      },
      {
        path: "/valid",
        directoryTree: {
          absPath: "/valid",
          childrenWereProcessed: true,
          childrenFiles: [{ name: "ok.ts" }],
          childrenDirs: [],
          numFiles: 1,
          fullSubtreeExtensionCounts: { ts: 1 },
        } as never,
      },
    ],
  } as unknown as SelectedContext
  const projected = projectSelectedWorkspaceContext(rawContext)
  assert.deepEqual(projected.folders, [
    { path: "/broken" },
    {
      path: "/valid",
      directoryTree: {
        absPath: "/valid",
        childrenWereProcessed: true,
        childrenFiles: [{ name: "ok.ts" }],
        childrenDirs: [],
        numFiles: 1,
        fullSubtreeExtensionCounts: { ts: 1 },
      },
    },
  ])
})
