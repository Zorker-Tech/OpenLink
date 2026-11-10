/** Run the host-owned step fallback when a production turn shell is absent. */

import { RunnerTurnAttempt, type RunnerUpdate, type SlateAgentRunnerResult } from "./runner-turn-attempt.ts"

export interface RunnerFallbackStepContext<State, RunOptions> {
  readonly signal: AbortSignal
  readonly emitUpdate: (update: RunnerUpdate) => void
  readonly prompt: string
  readonly runOptions: RunOptions
  readonly requestId: string
  readonly state: State
  readonly setState: (state: State) => void
}

export interface RunnerFallbackStepResult<Value> {
  readonly done: boolean
  readonly value?: Value
}

export interface RunnerFallbackStepLoopInput<Value, State, RunOptions> {
  readonly attempt: RunnerTurnAttempt
  readonly prompt: string
  readonly runOptions: RunOptions
  readonly maxSteps: number
  readonly state: State
  readonly setState: (state: State) => void
  readonly prepare?: () => Promise<void>
  readonly runStep?: (step: number, context: RunnerFallbackStepContext<State, RunOptions>) => Promise<RunnerFallbackStepResult<Value>>
  readonly settle?: (value: Value | undefined) => Promise<void>
  readonly emitUpdate: (update: RunnerUpdate) => void
}

export async function runFallbackStepLoop<Value, State, RunOptions>(
  input: RunnerFallbackStepLoopInput<Value, State, RunOptions>,
): Promise<Value | SlateAgentRunnerResult | undefined> {
  await input.prepare?.()
  if (input.attempt.signal.aborted) return input.attempt.outcome({ aborted: true })

  input.attempt.markStepDispatch()
  if (input.runStep == null) return undefined

  let value: Value | undefined
  let reachedEnd = false
  for (let index = 0; index < input.maxSteps; index += 1) {
    const outcome = await input.runStep(index, {
      signal: input.attempt.signal,
      emitUpdate: input.emitUpdate,
      prompt: input.prompt,
      runOptions: input.runOptions,
      requestId: input.attempt.runId,
      state: input.state,
      setState: input.setState,
    })
    if (outcome.done) {
      value = outcome.value
      reachedEnd = true
      break
    }
  }

  if (!reachedEnd) throw new Error(`Agent exceeded ${input.maxSteps} steps.`)
  await input.settle?.(value)

  const aborted = input.attempt.signal.aborted && !input.attempt.awaitingUser
  return input.attempt.hasReportedActivity ? input.attempt.outcome({ aborted }) : value
}
