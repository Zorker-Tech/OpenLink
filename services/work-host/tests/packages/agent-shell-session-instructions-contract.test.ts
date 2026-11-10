import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { renderContent } from "../../source/packages/prompt-jsx/index.ts"
import {
  getTmuxBackedShellSessionsSectionText,
  getTmuxBootstrapCommand,
  TmuxBackedShellInstructions,
} from "../../source/packages/agent/prompts/shell-session-instructions.ts"

describe("tmux-backed shell instructions", () => {
  it("reuses an existing session or creates a detached login shell in the current directory", () => {
    const command = getTmuxBootstrapCommand({ sharedSessionName: "dev" })

    assert.match(command, /^SESSION_NAME="dev";/)
    assert.match(command, /tmux -f \/exec-daemon\/tmux\.portal\.conf has-session/)
    assert.ok(command.indexOf("has-session") < command.indexOf("new-session"))
    assert.match(command, /\|\| tmux .*new-session -d -s "\$SESSION_NAME" -c "\$PWD"/)
    assert.match(command, /\$\{SHELL:-zsh\}.*-l$/)
    assert.match(getTmuxBootstrapCommand(), /SESSION_NAME="descriptive-task-name"/)
  })

  it("uses distinct naming guidance with and without a shared session", () => {
    const shared = getTmuxBackedShellSessionsSectionText({ sharedSessionName: "dev" })
    const independent = getTmuxBackedShellSessionsSectionText()

    assert.match(shared, /<tmux-backed-shell-sessions>/)
    assert.match(shared, /route it through `dev`/)
    assert.match(shared, /Only create a separate descriptively-named session/)
    assert.match(independent, /Use a descriptive tmux session name/)
    assert.match(independent, /Before creating a new session, list existing sessions/)
    assert.match(independent, /send-keys/)
  })

  it("requires tmux for interactive and long-running work in both prompt renderers", () => {
    const text = getTmuxBackedShellSessionsSectionText()
    const jsx = renderContent(TmuxBackedShellInstructions())

    for (const rendered of [text, jsx]) {
      assert.match(rendered, /must use tmux/i)
      assert.match(rendered, /Do NOT launch those workflows as one-shot background processes/)
      assert.match(rendered, /block_until_ms to 0/)
      assert.match(rendered, /attach-session/)
    }
  })
})
