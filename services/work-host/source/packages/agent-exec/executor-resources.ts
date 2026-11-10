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
import {
  createSpan,
  getSpanContextData,
  type SerializableSpanContext,
} from "../context/telemetry.ts"
import { createCounter } from "../metrics/index.ts"
import type { HookContextEntry } from "../hooks-carriers/hook-additional-context.ts"
import { getFirstItem } from "../utils/async-iterator.ts"

const logger = createLogger("agent-exec/executor")

const hookAdditionalContextDelivered = createCounter("agent_exec.hook_additional_context.delivered", {
  description: "Hook additional_context carriers drained into the caller collector",
  labelNames: ["hook_event_name"],
})

export interface ExecutorOptions {
  execId?: string | undefined
  hookContextCollector?: HookContextEntry[]
  deliverAgentStoreConflictNotices?: boolean
  enableAgentStoreConflictNotices?: boolean
}

export interface Executor<Args, Result> {
  execute(ctx: Context, args: Args, options?: ExecutorOptions): Promise<Result>
}

export interface StreamExecutor<Args, Event> {
  execute(ctx: Context, args: Args, options?: ExecutorOptions): AsyncIterable<Event>
}

export interface ExecutorWireRequestOptions {
  readonly execId?: string | undefined
  readonly spanContext?: SerializableSpanContext | undefined
  readonly collectHookContext: boolean
}

export interface ExecutorDecodedValue<Value> {
  readonly value: Value | undefined
  readonly hookContexts?: readonly HookContextEntry[] | undefined
}

type ExecRequestEncoder<Request> = {
  bivarianceHack(id: number): Request
}["bivarianceHack"]

export interface RemoteExecManager<Request = any, Response = any> {
  createExecInstance(
    ctx: Context,
    createMessage: ExecRequestEncoder<Request>,
  ): AsyncIterable<Response>
}

export class ExecutorResource<
  Args,
  Result,
  Request = any,
  Response = any,
> implements Executor<Args, Result> {
  constructor(
    private readonly execManager: RemoteExecManager,
    private readonly serializeArgs: (
      id: number,
      args: Args,
      options: ExecutorWireRequestOptions,
    ) => Request,
    private readonly deserializeResult: (message: Response) => ExecutorDecodedValue<Result>,
  ) {}

  async execute(parentCtx: Context, args: Args, options?: ExecutorOptions): Promise<Result> {
    using span = createSpan(parentCtx.withName("ExecutorResource.execute"))
    const ctx = span.ctx
    if (options?.execId !== undefined) span.span.setAttribute("exec.id", options.execId)
    const wireOptions: ExecutorWireRequestOptions = {
        ...(options?.execId === undefined ? {} : { execId: options.execId }),
        spanContext: getSpanContextData(ctx),
        collectHookContext: options?.hookContextCollector !== undefined,
    }
    const messageStream = this.execManager.createExecInstance(
      ctx,
      id => this.serializeArgs(id, args, wireOptions),
    ) as AsyncIterable<Response>
    const initial = await getFirstItem(messageStream)
    if (initial === undefined) throw new Error("No exec result")
    let result = initial.firstItem
    let rest = initial.rest
    const collect = (decoded: ExecutorDecodedValue<Result>): void => {
      const entries = decoded.hookContexts
      if (options?.hookContextCollector !== undefined && entries !== undefined && entries.length > 0) {
        options.hookContextCollector.push(...entries)
        for (const entry of entries) {
          hookAdditionalContextDelivered.increment(ctx, 1, { hook_event_name: entry.event })
        }
      }
    }
    let decoded = this.deserializeResult(result)
    collect(decoded)
    while (decoded.value === undefined) {
      const next = await getFirstItem(rest)
      if (next === undefined) throw new Error("No result value")
      result = next.firstItem
      rest = next.rest
      decoded = this.deserializeResult(result)
      collect(decoded)
    }
    // The answer is in hand; whatever the host still sends is context, so keep reading without holding
    // the caller up, and let the stream ending mid-drain stay a non-event.
    void (async () => {
      try {
        for await (const message of rest) collect(this.deserializeResult(message))
      } catch (error) {
        logger.info(ctx, "Ignoring exec stream shutdown during detached drain", { error })
      }
    })().catch(() => {})
    return decoded.value
  }
}

export class StreamExecutorResource<
  Args,
  Event,
  Request = any,
  Response = any,
> implements StreamExecutor<Args, Event> {
  constructor(
    private readonly execManager: RemoteExecManager,
    private readonly serializeArgs: (
      id: number,
      args: Args,
      options: ExecutorWireRequestOptions,
    ) => Request,
    private readonly deserializeStream: (message: Response) => ExecutorDecodedValue<Event>,
  ) {}

  async *execute(parentCtx: Context, args: Args, options?: ExecutorOptions): AsyncIterable<Event> {
    using span = createSpan(parentCtx.withName("StreamExecutorResource.execute"))
    const ctx = span.ctx
    const wireOptions: ExecutorWireRequestOptions = {
        ...(options?.execId === undefined ? {} : { execId: options.execId }),
        spanContext: getSpanContextData(ctx),
        collectHookContext: options?.hookContextCollector !== undefined || options?.deliverAgentStoreConflictNotices === true,
    }
    const messageStream = this.execManager.createExecInstance(
      ctx,
      id => this.serializeArgs(id, args, wireOptions),
    ) as AsyncIterable<Response>
    for await (const message of messageStream) {
      const decoded = this.deserializeStream(message)
      if (options?.hookContextCollector !== undefined && decoded.hookContexts !== undefined && decoded.hookContexts.length > 0) {
        options.hookContextCollector.push(...decoded.hookContexts)
      }
      if (decoded.value !== undefined) yield decoded.value
    }
  }
}
