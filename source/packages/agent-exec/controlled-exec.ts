/**
 * The host side of the exec channel: running the operations a client asks for.
 *
 * Handlers are tried in registration order and the first one that recognizes the message takes it; the
 * reply is a stream, because an operation may produce many messages before it is done. Two things ride
 * along with that stream: a heartbeat every few seconds, so a long operation is visibly alive rather
 * than merely quiet, and a closing message, so the client knows the operation ended instead of waiting
 * for a stream that will never speak again.
 *
 * A failure is reported as data rather than as a broken stream: the client is told what went wrong,
 * with the stack, the machine-readable code when there is one, and whatever git was able to say about
 * itself. A client that aborts an operation cancels its context, which is what makes the operation
 * itself stop.
 *
 * Hook context collected while the operation ran is attached to the messages it produced, and a
 * streaming operation sends the notices that arrived during it as one last message of their own.
 */

import type { Context } from "../context/context.ts"
import type { ExecServerControlMessage } from "../../adapters/interop/proto/generated/agent/v1/agent_service_pb.ts"
import { ExecClientControlMessage, ExecClientMessage, ExecServerMessage } from "../../adapters/interop/proto/generated/agent/v1/exec_pb.ts"
import { toInteropHookContextMessages } from "../../adapters/interop/agent/hook-context-adapter.ts"
import type { HookContextEntry } from "../hooks-carriers/hook-additional-context.ts"
import type { RegisteredControlledResource } from "./resource-provider.ts"
import { startControlledExecSession, unhandledControlledExecRequest } from "./controlled-exec-session.ts"

/** The runtime this operation would have run in is gone; the client should not retry into it. */
export class ControlledExecDisposedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ControlledExecDisposedError"
  }
}

function getExecClientErrorCode(error: unknown): string | undefined {
  if (error instanceof ControlledExecDisposedError) return "EXEC_BACKEND_UNAVAILABLE"
  if (error instanceof Error && error.name === "AgentExecStreamStartTimeoutError") return "AGENT_EXEC_STREAM_START_TIMEOUT"
  return undefined
}

export interface ControlledExecutor<Args, Result> {
  execute(ctx: Context, args: Args, options: {
    execId?: string | undefined
    hookContextCollector: HookContextEntry[]
    deliverAgentStoreConflictNotices: boolean
  }): Promise<Result>
}

export interface ControlledStreamExecutor<Args, Event> {
  execute(ctx: Context, args: Args, options: {
    execId?: string | undefined
    hookContextCollector: HookContextEntry[]
    deliverAgentStoreConflictNotices: boolean
  }): AsyncIterable<Event>
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

export interface ControlledResourceRegistry {
  entries(): Array<readonly [RegisteredControlledResource, unknown]>
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
