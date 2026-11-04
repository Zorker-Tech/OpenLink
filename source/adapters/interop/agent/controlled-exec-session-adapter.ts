import type { Context } from "../../../packages/context/context.ts"
import { createLogger } from "../../../packages/context/logging.ts"
import { appendGitDiagnostics } from "../../../packages/git-core/error-diagnostics.ts"
import { createCounter, createHistogram } from "../../../packages/metrics/index.ts"
import {
  ExecClientControlMessage,
  ExecClientHeartbeat,
  ExecClientMessage,
  ExecClientStreamClose,
  ExecClientThrow,
  ExecServerMessage,
} from "../proto/generated/agent/v1/exec_pb.ts"
import { createWritableIterable, WriteIterableClosedError } from "../../../packages/utils/writable-iterable.ts"

const logger = createLogger("agent-exec/controlled")
const EXEC_HEARTBEAT_INTERVAL_MS = 3_000

const executionDuration = createHistogram("agent_exec.controlled.exec.duration_ms", {
  description: "Duration of controlled exec operations in milliseconds",
  labelNames: ["exec_case"],
})
const executionSuccess = createCounter("agent_exec.controlled.exec.success", {
  description: "Count of successful controlled exec operations",
  labelNames: ["exec_case"],
})
const executionFailure = createCounter("agent_exec.controlled.exec.error", {
  description: "Count of failed controlled exec operations",
  labelNames: ["exec_case"],
})

export interface ControlledExecSessionInput {
  readonly context: Context
  readonly request: ExecServerMessage
  readonly operation: AsyncIterable<ExecClientMessage>
  readonly operationCase: string
  readonly cancelContext: (reason?: unknown) => void
  readonly includeGitStderr: () => boolean
  readonly errorCode: (error: unknown) => string | undefined
  readonly onSettled: () => void
}

/** Owns one response stream, its heartbeat, and the context that makes the operation cancellable. */
export function startControlledExecSession(input: ControlledExecSessionInput): AsyncIterable<ExecClientMessage | ExecClientControlMessage> {
  const output = createWritableIterable<ExecClientMessage | ExecClientControlMessage>()
  let heartbeat: ReturnType<typeof setTimeout> | undefined
  const sendHeartbeat = (): void => {
    heartbeat = setTimeout(() => {
      output.write(new ExecClientControlMessage({
        message: { case: "heartbeat", value: new ExecClientHeartbeat({ id: input.request.id }) },
      })).then(sendHeartbeat).catch(() => {})
    }, EXEC_HEARTBEAT_INTERVAL_MS)
  }
  sendHeartbeat()
  const startedAt = performance.now()

  const run = async (): Promise<void> => {
    try {
      for await (const message of input.operation) await output.write(message)
      await output.write(new ExecClientControlMessage({
        message: { case: "streamClose", value: new ExecClientStreamClose({ id: input.request.id }) },
      }))
      executionSuccess.increment(input.context, 1, { exec_case: input.operationCase })
    } catch (error) {
      // Ending the output consumer does not turn an operation into an execution failure.
      if (error instanceof WriteIterableClosedError) return
      executionFailure.increment(input.context, 1, { exec_case: input.operationCase })
      const stackTrace = error instanceof Error ? error.stack : undefined
      const code = input.errorCode(error)
      try {
        await output.write(new ExecClientControlMessage({
          message: {
            case: "throw",
            value: new ExecClientThrow({
              id: input.request.id,
              error: error instanceof Error
                ? appendGitDiagnostics(error.message, error, { includeStderr: input.includeGitStderr() })
                : "Unknown error",
              ...(stackTrace === undefined ? {} : { stackTrace }),
              ...(code === undefined ? {} : { errorCode: code }),
            }),
          },
        }))
      } catch (writeError) {
        if (!(writeError instanceof WriteIterableClosedError)) throw writeError
      }
    } finally {
      executionDuration.histogram(input.context, performance.now() - startedAt, { exec_case: input.operationCase })
      input.cancelContext()
      clearTimeout(heartbeat)
      output.close()
      input.onSettled()
    }
  }

  void run().catch(error => logger.error(input.context, "controlled exec session failed while reporting", error))
  return output
}

/** The reply for a request with no registered operation. */
export function unhandledControlledExecRequest(
  context: Context,
  request: ExecServerMessage,
  operationCase: string,
): AsyncIterable<ExecClientControlMessage> {
  const message = `No handler found for server message of type ${request.message.case}`
  logger.error(context, message, { messageCase: request.message.case })
  executionFailure.increment(context, 1, { exec_case: operationCase })
  return (async function* () {
    yield new ExecClientControlMessage({
      message: { case: "throw", value: new ExecClientThrow({ id: request.id, error: message }) },
    })
    yield new ExecClientControlMessage({
      message: { case: "streamClose", value: new ExecClientStreamClose({ id: request.id }) },
    })
  })()
}
