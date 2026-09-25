import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { loadSmartModeProjectPermissionsContext } from "../../source/packages/agent/smart-mode-project-permissions.ts"

// ---------------------------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------------------------

/** A workspace the test owns, with the project's permissions file written into it when asked. */
function workspaceWith(permissions: string | undefined) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-smart-mode-"))
  if (permissions !== undefined) {
    fs.mkdirSync(path.join(dir, ".slate"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".slate", "permissions.json"), permissions)
  }
  return dir
}

const cleanup = (dirs: readonly string[]) => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }) }

const instructions = (allow: string[], block: string[] = []) => ({ allowInstructions: allow, blockInstructions: block })

const load = (workspaces: readonly string[] | undefined, user?: ReturnType<typeof instructions>, project?: ReturnType<typeof instructions>) =>
  loadSmartModeProjectPermissionsContext(undefined, workspaces, user, project)

// ---------------------------------------------------------------------------------------------
// nothing to say
// ---------------------------------------------------------------------------------------------

test("a turn with no permissions anywhere has no policy", async () => {
  assert.equal(await load(undefined), undefined)
  assert.equal(await load([]), undefined)
  const dir = workspaceWith(undefined)
  try {
    assert.equal(await load([dir]), undefined)
  } finally {
    cleanup([dir])
  }
})

test("a workspace whose file has no policy contributes an empty one", async () => {
  // The file being there is what counts: a project that says nothing says nothing, rather than being absent.
  const dir = workspaceWith('{"somethingElse":true}')
  try {
    const context = await load([dir])
    assert.deepEqual(context?.auto_run, { allow_instructions: [], block_instructions: [] })
    assert.equal(context?.truncated, false)
  } finally {
    cleanup([dir])
  }
})

test("a workspace whose file cannot be read contributes nothing", async () => {
  const dir = workspaceWith("{ not json")
  try {
    assert.equal(await load([dir]), undefined)
  } finally {
    cleanup([dir])
  }
})

// ---------------------------------------------------------------------------------------------
// the project's own policy
// ---------------------------------------------------------------------------------------------

test("a project's file is read from each workspace", async () => {
  const first = workspaceWith('{"autoRun":{"allow_instructions":["run the tests"]}}')
  const second = workspaceWith('{"autoRun":{"block_instructions":["never push"]}}')
  try {
    const context = await load([first, second])
    assert.deepEqual(context?.auto_run.allow_instructions, ["run the tests"])
    assert.deepEqual(context?.auto_run.block_instructions, ["never push"])
    assert.equal(context?.truncated, false)
  } finally {
    cleanup([first, second])
  }
})

test("an instruction given by two workspaces is stated once", async () => {
  const first = workspaceWith('{"autoRun":{"allow_instructions":["run the tests"]}}')
  const second = workspaceWith('{"autoRun":{"allow_instructions":["run the tests"]}}')
  try {
    const context = await load([first, second])
    assert.deepEqual(context?.auto_run.allow_instructions, ["run the tests"])
  } finally {
    cleanup([first, second])
  }
})

test("a workspace path that is empty or not a string is skipped", async () => {
  const dir = workspaceWith('{"autoRun":{"allow_instructions":["run the tests"]}}')
  try {
    const context = await load([dir, "   ", 7 as never])
    assert.deepEqual(context?.auto_run.allow_instructions, ["run the tests"])
  } finally {
    cleanup([dir])
  }
})

test("a project's instructions the caller already parsed are used as they are", async () => {
  // The file is not even there; what the caller parsed is what the project said.
  const dir = workspaceWith(undefined)
  try {
    const context = await load([dir], undefined, instructions(["already parsed"]))
    assert.deepEqual(context?.auto_run.allow_instructions, ["already parsed"])
  } finally {
    cleanup([dir])
  }
})

// ---------------------------------------------------------------------------------------------
// the user's policy
// ---------------------------------------------------------------------------------------------

test("the user's own instructions follow the project's", async () => {
  const dir = workspaceWith('{"autoRun":{"allow_instructions":["run the tests"]}}')
  try {
    const context = await load([dir], instructions(["deploy to staging"]))
    assert.deepEqual(context?.auto_run.allow_instructions, ["run the tests", "deploy to staging"])
  } finally {
    cleanup([dir])
  }
})

test("the user's instruction is not repeated when the project already says it", async () => {
  const dir = workspaceWith('{"autoRun":{"allow_instructions":["run the tests"]}}')
  try {
    const context = await load([dir], instructions(["run the tests", "deploy to staging"]))
    assert.deepEqual(context?.auto_run.allow_instructions, ["run the tests", "deploy to staging"])
  } finally {
    cleanup([dir])
  }
})

test("a user with instructions and no project file still has a policy", async () => {
  const context = await load(undefined, instructions(["deploy to staging"]), undefined)
  assert.deepEqual(context?.auto_run.allow_instructions, ["deploy to staging"])
})

test("a user's empty policy is not a policy", async () => {
  assert.equal(await load(undefined, instructions([], [])), undefined)
})

// ---------------------------------------------------------------------------------------------
// what is bounded
// ---------------------------------------------------------------------------------------------

test("a project's instructions are bounded per workspace", async () => {
  const many = Array.from({ length: 25 }, (_, index) => `instruction ${index}`)
  const dir = workspaceWith(JSON.stringify({ autoRun: { allow_instructions: many } }))
  try {
    const context = await load([dir])
    // Twenty per workspace, and the caller is told the list was cut.
    assert.equal(context?.auto_run.allow_instructions.length, 20)
    assert.equal(context?.truncated, true)
  } finally {
    cleanup([dir])
  }
})

test("two workspaces allow twice as many instructions", async () => {
  const many = Array.from({ length: 25 }, (_, index) => `instruction ${index}`)
  const first = workspaceWith(JSON.stringify({ autoRun: { allow_instructions: many } }))
  const second = workspaceWith(JSON.stringify({ autoRun: { allow_instructions: many.map(entry => `${entry} b`) } }))
  try {
    const context = await load([first, second])
    assert.equal(context?.auto_run.allow_instructions.length, 40)
  } finally {
    cleanup([first, second])
  }
})

test("a user's instructions are bounded as well", async () => {
  const many = Array.from({ length: 25 }, (_, index) => `instruction ${index}`)
  const context = await load(undefined, instructions(many))
  assert.equal(context?.auto_run.allow_instructions.length, 20)
  assert.equal(context?.truncated, true)
})

test("a very long instruction is shortened and marked", async () => {
  const long = "x".repeat(1_500)
  const context = await load(undefined, instructions([long]))
  const written = context?.auto_run.allow_instructions[0] ?? ""
  assert.equal(written.length < 1_500, true)
  assert.match(written, /\.\.\.\[truncated\]$/)
  assert.equal(context?.truncated, true)
})

test("an instruction exactly at the limit is left alone", async () => {
  const exact = "x".repeat(1_000)
  const context = await load(undefined, instructions([exact]))
  assert.equal(context?.auto_run.allow_instructions[0], exact)
  assert.equal(context?.truncated, false)
})
