/**
 * The client side of an operation: ask the host to run it, and read what came back.
 *
 * A call opens one exec instance, sends the arguments once, and then reads messages until one of them
 * is this call's answer — the stream may carry messages for other operations in between, which is why
 * the result is searched for rather than assumed to be first. Each call runs inside its own span and
 * carries the trace context across to the host, so the host's work is part of the same trace.
 *
 * Two shapes exist because two kinds of operation do: one that answers once, and one that streams. The
 * streaming variant yields every event it recognizes and stops when the stream does.
 *
 * Hook context is the one thing that arrives out of band: the host may attach it to any message, and a
 * caller that brought a collector gets those carriers drained into it — the single-answer variant even
 * keeps draining after the answer, because the host may still be sending. Whether the host is asked to
 * attach context at all is decided by whether the caller has somewhere to put it.
 */

import type { Context } from "../context/context.ts"
import { createLogger } from "../context/logging.ts"
import { createSpan, getSpanContextData, type SerializableSpanContext } from "../context/telemetry.ts"
import { createCounter } from "../metrics/index.ts"
import { ExecClientMessage, ExecServerMessage, SpanContext } from "../proto/generated/agent/v1/exec_pb.ts"
import type { HookAdditionalContext } from "../proto/generated/agent/v1/hook_additional_context_pb.ts"
import { getFirstItem } from "../utils/async-iterator.ts"

const logger = createLogger("agent-exec/executor")

const hookAdditionalContextDelivered = createCounter("agent_exec.hook_additional_context.delivered", {
  description: "Hook additional_context carriers drained into the caller collector",
  labelNames: ["hook_event_name"],
})

/** The trace context travels as a message; a state that is absent is left absent, not sent as undefined. */
function toSpanContextMessage(spanContextData: SerializableSpanContext | undefined): SpanContext | undefined {
  if (spanContextData === undefined) return undefined
  return new SpanContext({
    traceId: spanContextData.traceId,
    spanId: spanContextData.spanId,
    traceFlags: spanContextData.traceFlags,
    ...(spanContextData.traceState !== undefined ? { traceState: spanContextData.traceState } : {}),
  })
}

export interface ExecutorOptions {
  execId?: string | undefined
  hookContextCollector?: HookAdditionalContext[]
  deliverAgentStoreConflictNotices?: boolean
  enableAgentStoreConflictNotices?: boolean
}

export interface Executor<Args, Result> {
  execute(ctx: Context, args: Args, options?: ExecutorOptions): Promise<Result>
}

export interface StreamExecutor<Args, Event> {
  execute(ctx: Context, args: Args, options?: ExecutorOptions): AsyncIterable<Event>
}

export interface RemoteExecManager {
  createExecInstance(ctx: Context, createMessage: (id: number) => ExecServerMessage): AsyncIterable<ExecClientMessage>
}

export class ExecutorResource<Args, Result> implements Executor<Args, Result> {
  constructor(
    private readonly execManager: RemoteExecManager,
    private readonly serializeArgs: (id: number, args: Args) => Pick<ExecServerMessage, "id" | "message">,
    private readonly deserializeResult: (message: ExecClientMessage) => Result | undefined,
  ) {}

  async execute(parentCtx: Context, args: Args, options?: ExecutorOptions): Promise<Result> {
    using span = createSpan(parentCtx.withName("ExecutorResource.execute"))
    const ctx = span.ctx
    if (options?.execId !== undefined) span.span.setAttribute("exec.id", options.execId)
    const spanContext = toSpanContextMessage(getSpanContextData(ctx))
    const messageStream = this.execManager.createExecInstance(ctx, (id) => {
      const serialized = this.serializeArgs(id, args)
      return new ExecServerMessage({
        id: serialized.id,
        message: serialized.message,
        ...(options?.execId !== undefined ? { execId: options.execId } : {}),
        ...(spanContext !== undefined ? { spanContext } : {}),
        acceptHookAdditionalContexts: options?.hookContextCollector !== undefined,
      })
    })
    const initial = await getFirstItem(messageStream)
    if (initial === undefined) throw new Error("No exec result")
    let result = initial.firstItem
    let rest = initial.rest
    const collect = (message: ExecClientMessage): void => {
      const carriers = message.hookAdditionalContexts
      if (options?.hookContextCollector !== undefined && carriers.length > 0) {
        options.hookContextCollector.push(...carriers)
        for (const carrier of carriers) {
          hookAdditionalContextDelivered.increment(ctx, 1, { hook_event_name: carrier.hookEventName })
        }
      }
    }
    collect(result)
    let value = this.deserializeResult(result)
    while (value === undefined) {
      const next = await getFirstItem(rest)
      if (next === undefined) throw new Error("No result value")
      result = next.firstItem
      rest = next.rest
      collect(result)
      value = this.deserializeResult(result)
    }
    // The answer is in hand; whatever the host still sends is context, so keep reading without holding
    // the caller up, and let the stream ending mid-drain stay a non-event.
    void (async () => {
      try {
        for await (const message of rest) collect(message)
      } catch (error) {
        logger.info(ctx, "Ignoring exec stream shutdown during detached drain", { error })
      }
    })().catch(() => {})
    return value
  }
}

export class StreamExecutorResource<Args, Event> implements StreamExecutor<Args, Event> {
  constructor(
    private readonly execManager: RemoteExecManager,
    private readonly serializeArgs: (id: number, args: Args) => Pick<ExecServerMessage, "id" | "message">,
    private readonly deserializeStream: (message: ExecClientMessage) => Event | undefined,
  ) {}

  async *execute(parentCtx: Context, args: Args, options?: ExecutorOptions): AsyncIterable<Event> {
    using span = createSpan(parentCtx.withName("StreamExecutorResource.execute"))
    const ctx = span.ctx
    const spanContext = toSpanContextMessage(getSpanContextData(ctx))
    const messageStream = this.execManager.createExecInstance(ctx, (id) => {
      const serialized = this.serializeArgs(id, args)
      return new ExecServerMessage({
        id: serialized.id,
        message: serialized.message,
        ...(options?.execId !== undefined ? { execId: options.execId } : {}),
        ...(spanContext !== undefined ? { spanContext } : {}),
        acceptHookAdditionalContexts: options?.hookContextCollector !== undefined || options?.deliverAgentStoreConflictNotices === true,
      })
    })
    for await (const message of messageStream) {
      const carriers = message.hookAdditionalContexts
      if (options?.hookContextCollector !== undefined && carriers.length > 0) options.hookContextCollector.push(...carriers)
      const value = this.deserializeStream(message)
      if (value !== undefined) yield value
    }
  }
}
