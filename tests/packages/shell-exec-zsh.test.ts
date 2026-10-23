import { test } from "node:test"
import { realpathSync } from "node:fs"
import assert from "node:assert/strict"

import { initZshState } from "../../source/packages/shell-exec/zsh.ts"
import { createContext } from "../../source/packages/context/context.ts"

// The full zsh executor spawns the user's zsh, so these tests run one for real; the environment is trimmed so a
// developer's own prompt and configuration cannot leak into what the executor reports. The executor's wrapper ends
// with a state dump whose helper comes from the initial snapshot, so stderr can carry that shell's own complaint;
// the command's own stdout and exit are what these tests pin down.
const env = { ...process.env, PS1: "", PROMPT: "", TERM: "dumb" }

const run = async (state: Awaited<ReturnType<typeof initZshState>>, command: string, options: Record<string, unknown> = {}) => {
  const events = []
  for await (const event of state.execute(createContext(), command, { env, ...options })) events.push(event)
  return events
}
const stdoutText = (events: Array<{ type: string; data?: unknown }>) =>
  events.filter((event) => event.type === "stdout").map((event) => Buffer.isBuffer(event.data) ? event.data.toString() : String(event.data ?? "")).join("")
const exitOf = (events: Array<{ type: string }>) => events.find((event) => event.type === "exit") as unknown as { code: number | null; aborted: boolean }

test("a state starts where the process is, and a clone starts elsewhere", async () => {
  const state = await initZshState({ env })
  assert.equal(realpathSync(await state.getCwd()), realpathSync(process.cwd()))
  assert.equal(await state.clone("/tmp").getCwd(), "/tmp")
  assert.equal(realpathSync(await state.getCwd()), realpathSync(process.cwd()))
})

test("a command's output and exit come back as events", async () => {
  const state = await initZshState({ env })
  const events = await run(state, "builtin printf 'hello\\n'")
  assert.equal(stdoutText(events), "hello\n")
  assert.equal(exitOf(events).code, 0)
  assert.equal(exitOf(events).aborted, false)
})

test("a failing command reports its exit", async () => {
  const state = await initZshState({ env })
  const events = await run(state, "builtin printf 'before\\n'; command false")
  assert.equal(stdoutText(events), "before\n")
  assert.notEqual(exitOf(events).code, 0)
})

test("a per-command directory is used for that command only", async () => {
  const state = await initZshState({ env })
  const moved = await run(state, "builtin pwd", { workingDirectory: "/tmp" })
  assert.equal(stdoutText(moved), realpathSync("/tmp") + "\n")
  assert.equal(realpathSync(await state.getCwd()), realpathSync(process.cwd()))
})

test("a command can be given its own environment", async () => {
  const state = await initZshState({ env })
  const events = await run(state, "builtin printf '%s\\n' \"$ONLY_HERE\"", { env: { ...env, ONLY_HERE: "present" } })
  assert.equal(stdoutText(events), "present\n")
})

test("piped stdin is handed over through the stdin event", async () => {
  const state = await initZshState({ env })
  const events = []
  for await (const event of state.execute(createContext(), "IFS= read -r line; builtin printf 'got:%s\\n' \"$line\"", { env, pipeStdin: true })) {
    events.push(event)
    const stdin = event.type === "stdin_ready" ? event.stdin : undefined
    if (stdin !== undefined) stdin.write("from-stdin\n", () => stdin.end())
  }
  assert.equal(stdoutText(events), "got:from-stdin\n")
})

test("an aborted run reports an aborted exit", async () => {
  const state = await initZshState({ env })
  const controller = new AbortController()
  const events = []
  for await (const event of state.execute(createContext(), "command sleep 5", { env, signal: controller.signal })) {
    events.push(event)
    if (event.type === "stdin_ready") controller.abort()
  }
  assert.equal(exitOf(events).aborted, true)
})

test("a background process that keeps the pipes open does not hold the run past its timeout", async () => {
  const state = await initZshState({ env })
  const startedAt = Date.now()
  const events = await run(state, "command sleep 3 & builtin printf 'done\\n'", { closeTimeout: 100 })
  assert.equal(stdoutText(events), "done\n")
  assert.equal(events.filter((event) => event.type === "exit").length, 1)
  assert.equal(Date.now() - startedAt < 2_000, true)
})
