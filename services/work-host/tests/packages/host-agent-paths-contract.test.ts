import assert from "node:assert/strict"
import test from "node:test"
import { isAbsolute, join, relative } from "node:path"
import { getSlateRootDir } from "../../source/host/host-paths.ts"
import {
  assertValidSlateAgentId,
  getSlateAgentsRootDir,
  resolveSlateAgentDir,
  SlateInvalidAgentIdError,
} from "../../source/host/storage/agent-paths.ts"

test("the agent directory is beneath the host's data root", () => {
  const homeDirectory = "/home/alex"
  const root = getSlateAgentsRootDir(homeDirectory)
  assert.equal(root, join(getSlateRootDir(homeDirectory), "agents"))
  assert.equal(isAbsolute(resolveSlateAgentDir("agent-7", homeDirectory)), true)
  assert.equal(relative(root, resolveSlateAgentDir("agent-7", homeDirectory)), "agent-7")
})

test("safe folder identifiers are kept exactly, while traversal and edge whitespace are rejected", () => {
  assert.doesNotThrow(() => assertValidSlateAgentId("agent-7"))
  assert.doesNotThrow(() => assertValidSlateAgentId("agent with space"))

  for (const id of ["", ".", "..", "../escape", "nested/agent", "nested\\agent", " agent", "agent ", "a\0b"]) {
    assert.throws(() => assertValidSlateAgentId(id), SlateInvalidAgentIdError, id)
    assert.throws(() => resolveSlateAgentDir(id), SlateInvalidAgentIdError, id)
  }
})
