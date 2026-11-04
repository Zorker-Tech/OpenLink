import assert from "node:assert/strict"
import { test } from "node:test"

import {
  isCommitPrefix,
  isFullCommitId,
  parseRemoteCommitRecords,
  selectResolvedCommit,
} from "../../source/packages/plugin-install/git-ref-resolution-policy.ts"

const commitA = "A123456789012345678901234567890123456789"
const commitB = "b123456789012345678901234567890123456789"

test("commit ids and abbreviations have separate length ranges", () => {
  assert.equal(isFullCommitId(commitA), true)
  assert.equal(isFullCommitId(commitA.slice(0, -1)), false)
  assert.equal(isCommitPrefix(commitA.slice(0, 7)), true)
  assert.equal(isCommitPrefix(commitA.slice(0, -1)), true)
  assert.equal(isCommitPrefix(commitA), false)
  assert.equal(isCommitPrefix("123456"), false)
})

test("remote rows accept only full object ids with a named ref", () => {
  assert.deepEqual(parseRemoteCommitRecords([
    "not-a-row",
    `short\trefs/heads/main`,
    `${commitA}\t`,
    `${commitA}\trefs/tags/v1`,
  ].join("\n")), [{ sha: commitA, refName: "refs/tags/v1" }])
})

test("annotated tag entries resolve to the peeled commit and otherwise keep the first ref", () => {
  assert.equal(selectResolvedCommit(`${commitA}\trefs/tags/v1\n${commitB}\trefs/tags/v1^{}`), commitB)
  assert.equal(selectResolvedCommit(`${commitA}\trefs/heads/main\n${commitB}\trefs/tags/v1`), commitA.toLowerCase())
  assert.equal(selectResolvedCommit("short\trefs/heads/main"), undefined)
  assert.equal(selectResolvedCommit(undefined), undefined)
})
