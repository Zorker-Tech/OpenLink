import { Code, ConnectError } from "@connectrpc/connect"
import { CustomErrorDetails, ErrorDetails, ErrorDetails_Error } from "../proto/generated/aiserver/v1/utils_pb.ts"
import {
  createLoopReminderContent,
  type AgentLoopErrorOptions,
} from "../../../packages/agent/loop-detection/agent-loop-detector.ts"

/** Connect error envelope and provider hint for a Slate loop-detection result. */
export class AgentLoopError extends ConnectError {
  declare readonly loopType: AgentLoopErrorOptions["loopType"]
  declare readonly singleMessageLoopKind?: string
  declare readonly repetitions?: number
  declare readonly period?: number | undefined

  constructor(options: AgentLoopErrorOptions) {
    const message = options.loopType === "assistantMessage"
      ? "Agent loop detected: pattern of " + options.patternLength + " messages repeating"
      : "Agent single-message loop detected: " + options.loopKind
    super(message, Code.FailedPrecondition, undefined, [
      new ErrorDetails({
        error: ErrorDetails_Error.INTERNAL,
        details: new CustomErrorDetails({
          title: "Agent Looping Detected",
          detail: "The model got stuck in a repeating response pattern, so this turn was stopped. Please try again with a different model or start a new conversation. If the problem persists, please contact support.",
          isRetryable: false,
        }),
      }),
    ])
    this.name = "AgentLoopError"
    this.loopType = options.loopType
    if (options.loopType === "singleMessage") {
      this.singleMessageLoopKind = options.loopKind
      this.repetitions = options.repetitions
      this.period = options.period
    }
  }
}

export function createLoopReminderMessage(options?: { readonly kind?: string | undefined }) {
  return {
    role: "user" as const,
    content: createLoopReminderContent(options),
    providerOptions: { slate: { loopReminder: true } },
  }
}
