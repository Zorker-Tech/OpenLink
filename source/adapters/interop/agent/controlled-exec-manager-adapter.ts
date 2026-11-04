/** Translate controlled operations and cancellation into the generated exec stream contract. */

import type { Context } from "../../../packages/context/context.ts"
import { createLogger } from "../../../packages/context/logging.ts"
import { appendGitDiagnostics } from "../../../packages/git-core/error-diagnostics.ts"
import { createCounter, createHistogram } from "../../../packages/metrics/index.ts"
import {
  ControlledExecDisposedError,
  type ControlledExecutor,
  type ControlledStreamExecutor,
} from "../../../packages/agent-exec/controlled-exec.ts"
import { AGENT_STORE_CONFLICT_HOOK_EVENT_NAME } from "../../../packages/agent-store-sync/agent-store-sync-contracts.ts"
import type { HookContextEntry } from "../../../packages/hooks-carriers/hook-additional-context.ts"
import type { RegisteredControlledResource } from "../../../packages/agent-exec/resource-provider.ts"
import type { ExecServerControlMessage } from "../proto/generated/agent/v1/agent_service_pb.ts"
import {
  ExecClientControlMessage,
  ExecClientHeartbeat,
  ExecClientMessage,
  ExecClientStreamClose,
  ExecClientThrow,
  ExecServerMessage,
} from "../proto/generated/agent/v1/exec_pb.ts"
import { toInteropHookContextMessages } from "./hook-context-adapter.ts"
import { startControlledExecSession, unhandledControlledExecRequest } from "./controlled-exec-session-adapter.ts"

export { ControlledExecDisposedError }
export type { ControlledExecutor, ControlledStreamExecutor }

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

function getExecClientErrorCode(error: unknown): string | undefined {
  if (error instanceof ControlledExecDisposedError) return "EXEC_BACKEND_UNAVAILABLE"
  if (error instanceof Error && error.name === "AgentExecStreamStartTimeoutError") return "AGENT_EXEC_STREAM_START_TIMEOUT"
  return undefined
}

export interface ControlledExecHandler {
  handle(ctx: Context, message: ExecServerMessage): AsyncIterable<ExecClientMessage> | undefined
}

export class SimpleControlledExecHandler<Args, Result> {
  constructor(
    private readonly exec: ControlledExecutor<Args, Result>,
    private readonly deserializeArgs: (message: ExecServerMessage) => { id: number; args: Args } | undefined,
    private readonly serializeResult: (id: number, result: Result) => ExecClientMessage,
  ) {}

  handle(ctx: Context, serverMessage: ExecServerMessage): AsyncIterable<ExecClientMessage> | undefined {
    const decoded = this.deserializeArgs(serverMessage)
    if (decoded === undefined) return undefined
    const self = this
    return (async function* () {
      const start = performance.now()
      const hookContextCollector: HookContextEntry[] = []
      const result = await self.exec.execute(ctx, decoded.args, {
        execId: serverMessage.execId,
        hookContextCollector,
        deliverAgentStoreConflictNotices: serverMessage.acceptHookAdditionalContexts === true,
      })
      const message = self.serializeResult(decoded.id, result)
      message.localExecutionTimeMs = Math.round(Math.max(0, performance.now() - start))
      if (hookContextCollector.length > 0) message.hookAdditionalContexts = toInteropHookContextMessages(hookContextCollector)
      yield message
    })()
  }
}

export class SimpleControlledStreamExecHandler<Args, Event> {
  constructor(
    private readonly exec: ControlledStreamExecutor<Args, Event>,
    private readonly deserializeArgs: (message: ExecServerMessage) => { id: number; args: Args } | undefined,
    private readonly serializeStream: (id: number, event: Event) => ExecClientMessage,
  ) {}

  handle(ctx: Context, serverMessage: ExecServerMessage): AsyncIterable<ExecClientMessage> | undefined {
    const decoded = this.deserializeArgs(serverMessage)
    if (decoded === undefined) return undefined
    const self = this
    return (async function* () {
      const start = performance.now()
      const hookContextCollector: HookContextEntry[] = []
      try {
        for await (const event of self.exec.execute(ctx, decoded.args, {
          execId: serverMessage.execId,
          hookContextCollector,
          deliverAgentStoreConflictNotices: serverMessage.acceptHookAdditionalContexts === true,
        })) {
          const message = self.serializeStream(decoded.id, event)
          message.localExecutionTimeMs = Math.round(Math.max(0, performance.now() - start))
          yield message
        }
      } finally {
        // A conflict notice is not an event of the operation: it is sent once, at the end, if one came up.
        const conflicts = hookContextCollector.filter(candidate => candidate.event === AGENT_STORE_CONFLICT_HOOK_EVENT_NAME)
        if (conflicts.length > 0) {
          yield new ExecClientMessage({ id: decoded.id, hookAdditionalContexts: toInteropHookContextMessages(conflicts) })
        }
      }
    })()
  }
}

export interface SimpleControlledExecManagerOptions {
  includeGitStderrInThrows?: boolean | (() => boolean)
}

export class SimpleControlledExecManager {
  private readonly handlers: ControlledExecHandler[] = []
  private readonly runningExecs = new Map<number, (reason?: unknown) => void>()
  private readonly includeGitStderrInThrows: () => boolean

  constructor(options?: SimpleControlledExecManagerOptions) {
    const includeStderr = options?.includeGitStderrInThrows !== undefined ? options.includeGitStderrInThrows : false
    this.includeGitStderrInThrows = typeof includeStderr === "function" ? includeStderr : () => includeStderr
  }

  register(handler: ControlledExecHandler): void {
    this.handlers.push(handler)
  }

  handleControlMessage(serverMessage: ExecServerControlMessage): void {
    if (serverMessage.message.case === "abort") {
      const id = serverMessage.message.value.id
      this.runningExecs.get(id)?.()
    }
  }

  handle(ctx: Context, serverMessage: ExecServerMessage): AsyncIterable<ExecClientMessage | ExecClientControlMessage> {
    const [execCtx, execCtxCancel] = ctx.withCancel()
    this.runningExecs.set(serverMessage.id, execCtxCancel)
    const execCase = serverMessage.message.case !== undefined ? serverMessage.message.case : "unknown"

    for (const handler of this.handlers) {
      const result = handler.handle(execCtx, serverMessage)
      if (result === undefined) continue
      return startControlledExecSession({
        context: execCtx,
        request: serverMessage,
        operation: result,
        operationCase: execCase,
        cancelContext: execCtxCancel,
        includeGitStderr: this.includeGitStderrInThrows,
        errorCode: getExecClientErrorCode,
        onSettled: () => this.runningExecs.delete(serverMessage.id),
      })
    }

    this.runningExecs.delete(serverMessage.id)
    execCtxCancel()
    return unhandledControlledExecRequest(ctx, serverMessage, execCase)
  }

  /** Builds a manager that can serve everything the registry holds, by asking each resource to register. */
  static fromResources(
    resources: ControlledResourceRegistry,
    options?: SimpleControlledExecManagerOptions,
  ): SimpleControlledExecManager {
    const execManager = new SimpleControlledExecManager(options)
    for (const [resource, implementation] of resources.entries()) {
      resource.registerControlledImplementation(implementation, execManager)
    }
    return execManager
  }
}

export interface ControlledResourceRegistry {
  entries(): Array<readonly [RegisteredControlledResource, unknown]>
}
