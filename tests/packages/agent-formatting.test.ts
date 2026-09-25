import { test } from "node:test"
import assert from "node:assert/strict"

import { LsDirectoryTreeNode, LsDirectoryTreeNode_File } from "../../source/packages/proto/generated/agent/v1/ls_exec_pb.ts"
import { renderAttachedFoldersContext } from "../../source/packages/agent/context/attached-folders-context.ts"
import { formatCodeBlock } from "../../source/packages/agent/tools/core/formatting.ts"

function tree(): LsDirectoryTreeNode {
  return new LsDirectoryTreeNode({
    absPath: "/p",
    childrenWereProcessed: true,
    numFiles: 1,
    childrenFiles: [new LsDirectoryTreeNode_File({ name: "a.ts" })],
    childrenDirs: [],
  } as never)
}

// ---------------------------------------------------------------------------------------------
// attached folders
// ---------------------------------------------------------------------------------------------

test("nothing is rendered when no folder was attached", () => {
  assert.equal(renderAttachedFoldersContext([]), undefined)
})

test("an attached folder is rendered as its tree", () => {
  const rendered = renderAttachedFoldersContext([{ path: "/p", directoryTree: tree() }])
  assert.match(rendered!, /^<attached_folders>/)
  assert.match(rendered!, /Here are some folder I manually attached/)
  assert.match(rendered!, /Folder: \/p/)
  assert.match(rendered!, /- a\.ts/)
  assert.match(rendered!, /<\/attached_folders>$/)
})

test("several folders are separated and named in the plural", () => {
  const rendered = renderAttachedFoldersContext([
    { path: "/a", directoryTree: tree() },
    { path: "/b", directoryTree: tree() },
  ])
  assert.match(rendered!, /Here are some folders I manually attached/)
  assert.match(rendered!, /Folder: \/a[\s\S]*Folder: \/b/)
})

test("a folder attached without a tree is skipped, and all of them skipped means nothing", () => {
  assert.equal(renderAttachedFoldersContext([{ path: "/p" }]), undefined)
  const rendered = renderAttachedFoldersContext([{ path: "/p" }, { path: "/q", directoryTree: tree() }])
  assert.match(rendered!, /Folder: \/q/)
  assert.doesNotMatch(rendered!, /Folder: \/p/)
})

// ---------------------------------------------------------------------------------------------
// code block formatting
// ---------------------------------------------------------------------------------------------

const baseBlock = {
  content: "one\ntwo",
  startLineNumber: 1,
  formattingOptions: {},
}

test("the default line numbers are padded and barred", () => {
  const formatted = formatCodeBlock(baseBlock, {})
  assert.equal(formatted, "     1|one\n     2|two")
})

test("line numbers can be turned off entirely", () => {
  const formatted = formatCodeBlock({ ...baseBlock, formattingOptions: { enableLineNumbers: false } }, {})
  assert.equal(formatted, "one\ntwo")
})

test("the two model-specific styles are used when the options ask for them", () => {
  assert.equal(
    formatCodeBlock({ ...baseBlock, formattingOptions: { gpt5CodexCatN: true } }, {}),
    "     1  one\n     2  two",
  )
  assert.equal(
    formatCodeBlock({ ...baseBlock, formattingOptions: { gpt5StyleLineNumbers: true } }, {}),
    "L1:one\nL2:two",
  )
})

test("sparse numbering shows only every nth line, without losing its numbers", () => {
  const block = { content: "a\nb\nc\nd", startLineNumber: 1, formattingOptions: { sparseLineNumbers: 2 } }
  assert.equal(formatCodeBlock(block, {}), "a\n     2|b\nc\n     4|d")
})

test("detailed lines keep their own numbers, and an unknown one is an ellipsis", () => {
  const block = {
    content: "",
    startLineNumber: 10,
    detailedLines: [{ lineNumber: 10, text: "a" }, { text: "b" }, { lineNumber: 12, text: "c" }],
    formattingOptions: {},
  }
  assert.equal(formatCodeBlock(block, {}), "    10|a\n   ...\n    12|c")
  assert.equal(
    formatCodeBlock({ ...block, formattingOptions: { gpt5StyleLineNumbers: true } }, {}),
    "L10:a\n...\nL12:c",
  )
  assert.equal(
    formatCodeBlock({ ...block, formattingOptions: { enableLineNumbers: false } }, {}),
    "a\nb\nc",
  )
})

test("the lines not shown are counted above and below when asked for", () => {
  const block = {
    content: "one\ntwo",
    startLineNumber: 5,
    totalLineNumbersInFile: 20,
    formattingOptions: {},
  }
  const formatted = formatCodeBlock(block, { addAmountOfOmittedLines: true })
  assert.match(formatted, /^\.\.\. 4 lines not shown \.\.\./)
  assert.match(formatted, /\.\.\. 14 lines not shown \.\.\.$/)
  // One line, one line's wording.
  const single = formatCodeBlock({ ...block, startLineNumber: 2, totalLineNumbersInFile: 3 }, { addAmountOfOmittedLines: true })
  assert.match(single, /^\.\.\. 1 line not shown \.\.\./)
})

test("the counts are left out when the caller does not ask for them", () => {
  const formatted = formatCodeBlock({ ...baseBlock, startLineNumber: 5, totalLineNumbersInFile: 20 }, {})
  assert.equal(formatted.includes("not shown"), false)
})

test("a tagged block carries its path, its language and whether it is the whole file", () => {
  const formatted = formatCodeBlock({
    ...baseBlock,
    tag: "code",
    filePath: "/p/a.ts",
    languageIdentifier: "ts",
    isFullFile: true,
    extraAttributes: { snippet: "1" },
  }, {})
  assert.equal(
    formatted,
    '\n<code path="/p/a.ts" isFullFile="true" language="ts" snippet="1">\n     1|one\n     2|two\n</code>\n',
  )
})

test("an empty block is written as an empty tag rather than as a tag around nothing", () => {
  // Numbering a blank line still produces a number, so an empty block is one with no lines at all.
  const formatted = formatCodeBlock({
    ...baseBlock,
    content: "",
    tag: "code",
    formattingOptions: { enableLineNumbers: false },
  }, {})
  assert.equal(formatted, "<code></code>")
})
