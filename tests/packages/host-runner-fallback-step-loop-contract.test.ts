import assert from "node:assert/strict"
import test from "node:test"

import { RunnerTurnAttempt } from "../../source/host/runner/runner-turn-attempt.ts"
import { runFallbackStepLoop } from "../../source/host/runner/runner-fallback-step-loop.ts"

test("preparation, bounded steps and settlement run in order around one attempt", async () => {
  const events: string[] = []
  const attempt = new RunnerTurnAttempt({ generation: 5, prompt: "work", runOptions: {} })
  let state = { completedSteps: [] as number[] }
  const result = await runFallbackStepLoop({
    attempt,
    prompt: "work",
    runOptions: { source: "test" },
    maxSteps: 2,
    state,
    setState: next => { state = next },
    async prepare() { events.push("prepare") },
    async runStep(step, context) {
      events.push(`step:${step}:${context.runOptions.source}`)
      context.emitUpdate({ type: "text-delta", text: "done" })
      context.setState({ completedSteps: [...context.state.completedSteps, step] })
      return { done: true, value: "finished" }
    },
    async settle(value) { events.push(`settle:${value}`) },
    emitUpdate: update => { attempt.observe(update) },
  })

  assert.deepEqual(events, ["prepare", "step:0:test", "settle:finished"])
  assert.deepEqual(state.completedSteps, [0])
  assert.equal(attempt.dispatchStarted, true)
  assert.deepEqual(result, {
    text: "done",
    sentMessageCount: 0,
    reacted: false,
    aborted: false,
    streamOutputProduced: true,
  })
})

test("a preparation-time cancellation returns before dispatch", async () => {
  const attempt = new RunnerTurnAttempt({ generation: 1, prompt: "work", runOptions: {} })
  let stepped = false
  const result = await runFallbackStepLoop({
    attempt,
    prompt: "work",
    runOptions: {},
    maxSteps: 2,
    state: {},
    setState: () => {},
    async prepare() { attempt.cancel({ intentional: true }) },
    async runStep() { stepped = true; return { done: true } },
    emitUpdate: () => {},
  })

  assert.equal(stepped, false)
  assert.equal(attempt.dispatchStarted, false)
  assert.deepEqual(result, { text: "", sentMessageCount: 0, reacted: false, aborted: true })
})

test("a loop that never completes fails at its configured step bound", async () => {
  const attempt = new RunnerTurnAttempt({ generation: 1, prompt: "work", runOptions: {} })
  let settled = false

  await assert.rejects(runFallbackStepLoop({
    attempt,
    prompt: "work",
    runOptions: {},
    maxSteps: 1,
    state: {},
    setState: () => {},
    async runStep() { return { done: false } },
    async settle() { settled = true },
    emitUpdate: () => {},
  }), /Agent exceeded 1 steps\./)
  assert.equal(settled, false)
})

test("a runner without a step adapter marks dispatch and returns no value", async () => {
  const attempt = new RunnerTurnAttempt({ generation: 1, prompt: "work", runOptions: {} })
  const result = await runFallbackStepLoop({
    attempt,
    prompt: "work",
    runOptions: {},
    maxSteps: 1,
    state: {},
    setState: () => {},
    emitUpdate: () => {},
  })

  assert.equal(attempt.dispatchStarted, true)
  assert.equal(result, undefined)
})
