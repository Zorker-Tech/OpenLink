import { randomUUID } from "node:crypto"

export type RunnerUpdate =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "thinking-delta"; readonly text: string }
  | { readonly type: "tool-call"; readonly id: string; readonly name?: string; readonly status?: string; readonly summary?: string; readonly args?: string }
  | { readonly type: "send-message"; readonly message: Readonly<Record<string, unknown>> & { readonly type: string }; readonly timestampMs: number; readonly ackToken?: string }
  | { readonly type: "turn-ended"; readonly usage?: unknown }
  | { readonly type: "react-to-message"; readonly messageAddress: string; readonly emoji: string }
  | { readonly type: "request-id"; readonly requestId: string }
  | { readonly type: "retrying" }

export interface SlateAgentRunnerResult {
  readonly text: string
  readonly sentMessageCount: number
  readonly reacted: boolean
  readonly aborted: boolean
  readonly quiescedForUpgrade?: boolean
  readonly awaitingUserSelection?: boolean
  readonly streamOutputProduced?: boolean
}

export interface RunnerTurnAttemptOptions {
  readonly inferenceRequestId?: string
  readonly messageId?: string
  readonly recentUserMessages?: readonly { readonly id: string; readonly text: string }[]
  readonly selectedImages?: readonly unknown[]
  readonly attachedFilePaths?: readonly string[]
  readonly selectedVideos?: readonly unknown[]
  readonly replyContext?: unknown
  readonly requestSource?: string
}

export interface RunnerTurnAttemptInput {
  readonly generation: number
  readonly prompt: string
  readonly runOptions: RunnerTurnAttemptOptions
}

export interface RunnerTurnUpdateEffects {
  readonly firstVisibleOutput: boolean
  readonly needsUserInput: boolean
}

const visibleOutputKinds = new Set<RunnerUpdate["type"]>(["text-delta", "thinking-delta", "tool-call"])
const userSelectionMessageKinds = new Set(["widget", "secret-request", "auto-review-approval"])

export class RunnerTurnAttempt {
  readonly runId: string
  readonly signal: AbortSignal
  readonly epoch: number
  readonly recoverableReplay: boolean
  readonly #abortController = new AbortController()
  #dispatched = false
  #awaitingUserSelection = false
  #text = ""
  #sentMessageCount = 0
  #reacted = false
  #streamOutputProduced = false

  constructor(input: RunnerTurnAttemptInput) {
    const { runOptions, prompt } = input
    this.runId = runOptions.inferenceRequestId ?? randomUUID()
    this.signal = this.#abortController.signal
    this.epoch = input.generation
    this.recoverableReplay = mayRecoverPriorMessage(runOptions, prompt)
  }

  get dispatchStarted(): boolean {
    return this.#dispatched
  }

  get awaitingUser(): boolean {
    return this.#awaitingUserSelection
  }

  get visibleOutputProduced(): boolean {
    return this.#streamOutputProduced
  }

  get hasReportedActivity(): boolean {
    return this.#text.length > 0 || this.#sentMessageCount > 0 || this.#reacted
  }

  markStepDispatch(): void {
    this.#dispatched = true
  }

  observe(update: RunnerUpdate): RunnerTurnUpdateEffects {
    const firstVisibleOutput = visibleOutputKinds.has(update.type) && !this.#streamOutputProduced
    if (firstVisibleOutput) this.#streamOutputProduced = true

    if (update.type === "text-delta") this.#text += update.text
    if (update.type === "send-message") {
      this.#sentMessageCount += 1
      if (userSelectionMessageKinds.has(update.message.type)) this.#awaitingUserSelection = true
    }

    return { firstVisibleOutput, needsUserInput: this.#awaitingUserSelection }
  }

  noteReactionApplied(applied: boolean): void {
    if (applied) this.#reacted = true
  }

  cancel(reason?: unknown): void {
    this.#abortController.abort(reason)
  }

  outcome(input: { readonly aborted: boolean; readonly quiescedForUpgrade?: boolean }): SlateAgentRunnerResult {
    return {
      text: this.#text,
      sentMessageCount: this.#sentMessageCount,
      reacted: this.#reacted,
      aborted: input.aborted,
      ...(this.#awaitingUserSelection ? { awaitingUserSelection: true } : {}),
      ...(input.quiescedForUpgrade === true ? { quiescedForUpgrade: true } : {}),
      ...(this.#streamOutputProduced ? { streamOutputProduced: true } : {}),
    }
  }
}

function mayRecoverPriorMessage(options: RunnerTurnAttemptOptions, prompt: string): boolean {
  const { messageId, recentUserMessages } = options
  if (messageId == null) return false
  if ((options.selectedImages?.length ?? 0) > 0 || (options.attachedFilePaths?.length ?? 0) > 0 || (options.selectedVideos?.length ?? 0) > 0) return false
  if (options.replyContext != null) return false
  const priorText = recentUserMessages?.find(message => message.id === messageId)?.text
  return priorText === prompt
}
