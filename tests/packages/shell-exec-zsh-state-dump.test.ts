import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import dumpZshState, {
  ZSH_STATE_END_MARKER,
  ZSH_STATE_START_MARKER,
} from "../../source/packages/shell-exec/dump_zsh_state.ts"

function decodedBlock(output: string, name: string): string {
  const delimiter = `SLATE_STATE_EOF_${name}`
  const header = `slate_state_${name}=$(command base64 -d <<${delimiter}\n`
  const start = output.indexOf(header)
  assert.notEqual(start, -1, `${name} block is present`)
  const payloadStart = start + header.length
  const payloadEnd = output.indexOf(`\n${delimiter}`, payloadStart)
  assert.notEqual(payloadEnd, -1, `${name} block has a terminator`)
  return Buffer.from(output.slice(payloadStart, payloadEnd), "base64").toString("utf8")
}

test("the zsh snapshot preserves state, filters scoped variables and brackets complete output", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "slate-zsh-state-dump-"))
  const script = [
    dumpZshState,
    "function slate_dump_probe() { builtin print -r -- probe; }",
    "alias slate_dump_alias='builtin print alias'",
    "dump_zsh_state",
  ].join("\n")
  try {
    const child = spawnSync("zsh", ["-c", script], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: home,
        ZDOTDIR: home,
        TERM: "dumb",
        SLATE_DUMP_PROBE: "keep-me",
        SLATE_SANDBOX_TEST_VALUE: "drop-me",
        SLATE_CONVERSATION_ID: "drop-this-session",
      },
    })

    assert.equal(child.status, 0, child.stderr)
    assert.equal(child.stdout.split("\n")[0], ZSH_STATE_START_MARKER)
    assert.equal(child.stdout.trimEnd().split("\n").at(-1), ZSH_STATE_END_MARKER)

    const environment = decodedBlock(child.stdout, "ENV_VARS_B64")
    assert.match(environment, /SLATE_DUMP_PROBE=keep-me/)
    assert.doesNotMatch(environment, /SLATE_SANDBOX_TEST_VALUE|SLATE_CONVERSATION_ID/)

    const options = decodedBlock(child.stdout, "ZSH_OPTS_B64")
    assert.doesNotMatch(options, /^(?:builtin )?setopt (?:errreturn|nounset|pipefail)$/m)

    const functions = decodedBlock(child.stdout, "FUNCTIONS_B64")
    assert.match(functions, /slate_dump_probe/)
    assert.match(child.stdout, /slate_dump_alias/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
