import { test } from "node:test"
import { realpathSync } from "node:fs"
import assert from "node:assert/strict"

import { initZshLightState } from "../../source/packages/shell-exec/zsh-light.ts"
import { createContext } from "../../source/packages/context/context.ts"

// The light shell executor spawns the user's zsh, so these tests run one for real; the environment is trimmed so a
// developer's own prompt and configuration cannot leak into what the executor reports.
const env = { ...process.env, PS1: "", PROMPT: "", TERM: "dumb" }

const run = async (state: Awaited<ReturnType<typeof initZshLightState>>, command: string, options: Record<string, unknown> = {}) => {
  const events = []
  for await (const event of state.execute(createContext(), command, { env, ...options })) events.push(event)
  return events
}
const outputText = (events: Array<{ type: string; data?: unknown }>) =>
  events.filter((event) => event.type === "stdout" || event.type === "stderr").map((event) => Buffer.isBuffer(event.data) ? event.data.toString() : String(event.data ?? "")).join("")

test("a light state starts where the process is, and a clone starts elsewhere", async () => {
  const state = await initZshLightState({ env })
  assert.equal(realpathSync(await state.getCwd()), realpathSync(process.cwd()))
  assert.equal(await state.clone("/tmp").getCwd(), "/tmp")
  assert.equal(realpathSync(await state.getCwd()), realpathSync(process.cwd()))
})

test("a command's output and exit come back as events", async () => {
  const state = await initZshLightState({ env })
  const events = await run(state, "builtin printf 'hello\\n'")
  assert.equal(outputText(events), "hello\n")
  const exit = events.find((event) => event.type === "exit") as unknown as { code: number | null; aborted: boolean }
  assert.equal(exit.code, 0)
  assert.equal(exit.aborted, false)
})

test("the directory and exported variables carry between commands", async () => {
  const state = await initZshLightState({ env })
  await run(state, "builtin export ZL_TEST=kept; builtin cd /tmp; builtin pwd")
  const events = await run(state, "builtin printf '%s\\n' \"$ZL_TEST\"; builtin pwd")
  assert.equal(outputText(events), "kept\n" + realpathSync("/tmp") + "\n")
  assert.equal(await state.getCwd(), realpathSync("/tmp"))
})

test("a function defined in one command is not carried to the next", async () => {
  const state = await initZshLightState({ env })
  const define = await run(state, "zl_fn() { builtin printf 'fn\\n'; }; builtin printf 'defined\\n'")
  assert.equal(outputText(define), "defined\n")
  const call = await run(state, "zl_fn")
  const exit = call.find((event) => event.type === "exit") as unknown as { code: number | null }
  assert.notEqual(exit.code, 0)
})

test("a failing command reports its exit and the state survives", async () => {
  const state = await initZshLightState({ env })
  const failed = await run(state, "builtin printf 'before\\n'; command false")
  assert.equal(outputText(failed), "before\n")
  assert.notEqual((failed.find((event) => event.type === "exit") as unknown as { code: number | null }).code, 0)
  const after = await run(state, "builtin printf 'after\\n'")
  assert.equal(outputText(after), "after\n")
  assert.equal((after.find((event) => event.type === "exit") as unknown as { code: number | null }).code, 0)
})

test("each command can be given its own environment", async () => {
  const state = await initZshLightState({ env })
  const withEnv = await run(state, "builtin printf '%s\\n' \"$ONLY_HERE\"", { env: { ...env, ONLY_HERE: "present" } })
  assert.equal(outputText(withEnv), "present\n")
  const withoutEnv = await run(state, "builtin printf '%s\\n' \"$ONLY_HERE\"")
  assert.equal(outputText(withoutEnv), "present\n")
})

test("piped stdin is handed over through the stdin event", async () => {
  const state = await initZshLightState({ env })
  const events = []
  for await (const event of state.execute(createContext(), "IFS= read -r line; builtin printf 'got:%s\\n' \"$line\"", { env, pipeStdin: true })) {
    events.push(event)
    const stdin = event.type === "stdin_ready" ? event.stdin : undefined
    if (stdin !== undefined) {
      stdin.write("from-stdin\n", () => stdin.end())
    }
  }
  assert.equal(outputText(events), "got:from-stdin\n")
})

test("an aborted run reports an aborted exit", async () => {
  const state = await initZshLightState({ env })
  const controller = new AbortController()
  const events = []
  for await (const event of state.execute(createContext(), "command sleep 5", { env, signal: controller.signal })) {
    events.push(event)
    if (event.type === "stdin_ready") controller.abort()
  }
  const exit = events.find((event) => event.type === "exit") as unknown as { aborted: boolean }
  assert.equal(exit.aborted, true)
})
test("the shell overrides win over the environment the caller hands in", async () => {
  const state = await initZshLightState({ env: { ...env, TERM: "xterm-256color" } })
  const initTerm = await run(state, "builtin printf '%s\\n' \"$TERM\"")
  assert.equal(outputText(initTerm), "xterm-256color\n")
})

test("a background process that keeps the pipes open does not hold the run past its timeout", async () => {
  const state = await initZshLightState({ env })
  const startedAt = Date.now()
  const events = []
  for await (const event of state.execute(createContext(), "command sleep 3 & builtin printf 'done\\n'", { env, closeTimeout: 100 })) events.push(event)
  const elapsed = Date.now() - startedAt
  assert.equal(outputText(events), "done\n")
  assert.equal(events.filter((event) => event.type === "exit").length, 1)
  assert.equal(elapsed < 2_000, true)
})
