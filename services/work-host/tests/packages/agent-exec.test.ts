import { test } from "node:test"
import assert from "node:assert/strict"

import { createContext, type Context } from "../../source/packages/context/context.ts"
import { toInteropHookContextMessages } from "../../source/adapters/interop/agent/hook-context-adapter.ts"
import type { HookContextEntry } from "../../source/packages/hooks-carriers/hook-additional-context.ts"
import {
  ExecClientControlMessage,
  ExecClientMessage,
  ExecServerMessage,
  ExecuteHookArgs,
  ExecuteHookRequest,
  ExecuteHookResult,
} from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts"
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "../../source/adapters/interop/agent/exec-message-adapter.ts"
import {
  CombinedResourceAccessor,
  RegistryResourceAccessor,
  RemoteResourceAccessor,
  createResource,
  resourceEntry,
} from "../../source/packages/agent-exec/resource-provider.ts"
import {
  ExecutorResource,
  StreamExecutorResource,
  type Executor,
  type RemoteExecManager,
} from "../../source/packages/agent-exec/executor-resources.ts"
import {
  ControlledExecDisposedError,
  SimpleControlledExecHandler,
  SimpleControlledExecManager,
  SimpleControlledStreamExecHandler,
} from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts"
import { hookExecutorResource } from "../../source/packages/agent-exec/hook-executor.ts"

const ctx = (): Context => createContext()

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iterable) items.push(item)
  return items
}

function hookCarrier(text: string, event = "preToolUse"): HookContextEntry {
  return { event, text }
}

function wireHookCarrier(text: string, event = "preToolUse") {
  return toInteropHookContextMessages([hookCarrier(text, event)])[0]!
}

// ---------------------------------------------------------------------------------------------
// agent-exec: putting a typed call into the channel's message
// ---------------------------------------------------------------------------------------------

test("arguments are wrapped under their own case with the call's id", () => {
  const serialize = createServerSerializer("executeHookArgs")
  const args = new ExecuteHookArgs({ request: new ExecuteHookRequest({ request: { case: undefined } }) })
  const message = serialize(7, args)
  assert.equal(message.id, 7)
  assert.equal(message.message.case, "executeHookArgs")
  assert.equal(message.message.value, args)
})

test("a result is wrapped under its own case", () => {
  const serialize = createClientSerializer("executeHookResult")
  const message = serialize(3, new ExecuteHookResult())
  assert.equal(message.id, 3)
  assert.equal(message.message.case, "executeHookResult")
  assert.ok(message.message.value instanceof ExecuteHookResult)
})

test("a deserializer answers only for the case it was built for", () => {
  const deserialize = createServerDeserializer("executeHookArgs")
  const mine = new ExecServerMessage({
    id: 5,
    message: { case: "executeHookArgs", value: new ExecuteHookArgs() },
  })
  assert.deepEqual(deserialize(mine), { id: 5, args: new ExecuteHookArgs() })

  const someoneElses = new ExecServerMessage({ id: 6, message: { case: undefined } })
  assert.equal(deserialize(someoneElses), undefined)
})

test("a client deserializer hands back the value or nothing", () => {
  const deserialize = createClientDeserializer("executeHookResult")
  const result = new ExecuteHookResult()
  assert.deepEqual(
    deserialize(new ExecClientMessage({ id: 1, message: { case: "executeHookResult", value: result } })),
    { value: result },
  )
  assert.deepEqual(
    deserialize(new ExecClientMessage({ id: 2, message: { case: undefined } })),
    { value: undefined },
  )
  assert.deepEqual(
    deserialize(new ExecClientMessage({
      id: 3,
      message: { case: undefined },
      hookAdditionalContexts: [wireHookCarrier("carried by a different operation")],
    })),
    {
      value: undefined,
      hookContexts: [hookCarrier("carried by a different operation")],
    },
  )
  assert.deepEqual(
    deserialize({
      id: 4,
      message: { case: "executeHookResult", value: result },
    } as unknown as ExecClientMessage),
    { value: result },
  )
})

// ---------------------------------------------------------------------------------------------
// agent-exec: naming an operation
// ---------------------------------------------------------------------------------------------

test("a resource is identified by a symbol of its own, so two lookalikes stay apart", () => {
  const first = createResource(() => "remote", () => {})
  const second = createResource(() => "remote", () => {})
  assert.equal(typeof first.symbol, "symbol")
  assert.notEqual(first.symbol, second.symbol)
})

test("the remote accessor builds each operation's client side from the manager", () => {
  const resource = createResource((manager: { label: string }) => `remote:${manager.label}`, () => {})
  assert.equal(new RemoteResourceAccessor({ label: "one" }).get(resource), "remote:one")
})

test("the registry accessor finds what was registered, and nothing else", () => {
  const resource = createResource(() => "remote", () => {})
  const other = createResource(() => "remote", () => {})
  const registry = new RegistryResourceAccessor()
  assert.equal(registry.get(resource), undefined)
  registry.register(resource, "local")
  assert.equal(registry.get(resource), "local")
  assert.equal(registry.get(other), undefined)
  assert.equal(registry.entries().length, 1)
  assert.equal(registry.entries()[0]?.[1], "local")
})

test("a local implementation wins over the remote one, and the rest fall through", () => {
  const overridden = createResource((manager: { label: string }) => `remote:${manager.label}`, () => {})
  const passedThrough = createResource((manager: { label: string }) => `remote:${manager.label}`, () => {})
  const base = new RemoteResourceAccessor({ label: "base" })
  const combined = new CombinedResourceAccessor(base, [resourceEntry(overridden, "local")])
  assert.equal(combined.get(overridden), "local")
  assert.equal(combined.get(passedThrough), "remote:base")
})

// ---------------------------------------------------------------------------------------------
// agent-exec: the client side of a call
// ---------------------------------------------------------------------------------------------

function fakeExecManager(script: {
  onMessage?: (message: ExecServerMessage) => void
  messages: ExecClientMessage[]
}): RemoteExecManager {
  return {
    createExecInstance(_ctx, createMessage) {
      script.onMessage?.(createMessage(11))
      return (async function* () {
        for (const message of script.messages) yield message
      })()
    },
  }
}

test("a single-answer call sends its arguments once and returns the matching answer", async () => {
  const sent: ExecServerMessage[] = []
  const manager = fakeExecManager({
    messages: [
      new ExecClientMessage({ id: 99, message: { case: undefined } }),
      new ExecClientMessage({ id: 11, message: { case: "executeHookResult", value: new ExecuteHookResult() } }),
    ],
    onMessage: message => sent.push(message),
  })
  const executor = new ExecutorResource<ExecuteHookArgs, ExecuteHookResult>(
    manager,
    createServerSerializer("executeHookArgs"),
    createClientDeserializer("executeHookResult"),
  )
  const result = await executor.execute(ctx(), new ExecuteHookArgs(), { execId: "exec-1" })
  assert.ok(result instanceof ExecuteHookResult)
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.id, 11)
  assert.equal(sent[0]?.message.case, "executeHookArgs")
  assert.equal(sent[0]?.execId, "exec-1")
  assert.equal(sent[0]?.acceptHookAdditionalContexts, false)
})

test("a stream that answers nothing is reported as having no result", async () => {
  const executor = new ExecutorResource<ExecuteHookArgs, ExecuteHookResult>(
    fakeExecManager({ messages: [] }),
    createServerSerializer("executeHookArgs"),
    createClientDeserializer("executeHookResult"),
  )
  await assert.rejects(executor.execute(ctx(), new ExecuteHookArgs()), /No exec result/)
})

test("a stream that never carries this call's answer is reported as such", async () => {
  const executor = new ExecutorResource<ExecuteHookArgs, ExecuteHookResult>(
    fakeExecManager({
      messages: [
        new ExecClientMessage({ id: 1, message: { case: undefined } }),
        new ExecClientMessage({ id: 2, message: { case: undefined } }),
      ],
    }),
    createServerSerializer("executeHookArgs"),
    createClientDeserializer("executeHookResult"),
  )
  await assert.rejects(executor.execute(ctx(), new ExecuteHookArgs()), /No result value/)
})

test("hook context attached to any message is drained into the caller's collector", async () => {
  const collected: HookContextEntry[] = []
  const manager = fakeExecManager({
    messages: [
      new ExecClientMessage({ id: 1, message: { case: undefined }, hookAdditionalContexts: [wireHookCarrier("first")] }),
      new ExecClientMessage({ id: 11, message: { case: "executeHookResult", value: new ExecuteHookResult() } }),
    ],
  })
  const executor = new ExecutorResource<ExecuteHookArgs, ExecuteHookResult>(
    manager,
    createServerSerializer("executeHookArgs"),
    createClientDeserializer("executeHookResult"),
  )
  await executor.execute(ctx(), new ExecuteHookArgs(), { hookContextCollector: collected })
  assert.deepEqual(collected.map(carrier => carrier.text), ["first"])
})

test("the host is asked for hook context only when the caller has somewhere to put it", async () => {
  const sent: ExecServerMessage[] = []
  const manager = fakeExecManager({
    messages: [new ExecClientMessage({ id: 11, message: { case: "executeHookResult", value: new ExecuteHookResult() } })],
    onMessage: message => sent.push(message),
  })
  const executor = new ExecutorResource<ExecuteHookArgs, ExecuteHookResult>(
    manager,
    createServerSerializer("executeHookArgs"),
    createClientDeserializer("executeHookResult"),
  )
  await executor.execute(ctx(), new ExecuteHookArgs(), { hookContextCollector: [] })
  assert.equal(sent[0]?.acceptHookAdditionalContexts, true)
})

test("a streaming call yields every event it recognizes and ignores the rest", async () => {
  const collected: HookContextEntry[] = []
  const manager = fakeExecManager({
    messages: [
      new ExecClientMessage({ id: 1, message: { case: "executeHookResult", value: new ExecuteHookResult() } }),
      new ExecClientMessage({ id: 2, message: { case: undefined } }),
      new ExecClientMessage({ id: 3, message: { case: "executeHookResult", value: new ExecuteHookResult() }, hookAdditionalContexts: [wireHookCarrier("mid")] }),
    ],
  })
  const executor = new StreamExecutorResource<ExecuteHookArgs, ExecuteHookResult>(
    manager,
    createServerSerializer("executeHookArgs"),
    createClientDeserializer("executeHookResult"),
  )
  const events = await collect(executor.execute(ctx(), new ExecuteHookArgs(), { hookContextCollector: collected }))
  assert.equal(events.length, 2)
  assert.deepEqual(collected.map(carrier => carrier.text), ["mid"])
})

// ---------------------------------------------------------------------------------------------
// agent-exec: the host side of a call
// ---------------------------------------------------------------------------------------------

const serverMessageFor = (id: number): ExecServerMessage =>
  new ExecServerMessage({ id, message: { case: "executeHookArgs", value: new ExecuteHookArgs() } })

test("a handler answers a message it recognizes with the serialized result", async () => {
  const handler = new SimpleControlledExecHandler<ExecuteHookArgs, ExecuteHookResult>(
    {
      async execute(_ctx, _args, options) {
        options.hookContextCollector.push(hookCarrier("from the hook"))
        return new ExecuteHookResult()
      },
    },
    createServerDeserializer("executeHookArgs"),
    createClientSerializer("executeHookResult"),
  )
  const messages = await collect(handler.handle(ctx(), serverMessageFor(4))!)
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.id, 4)
  assert.equal(messages[0]?.message.case, "executeHookResult")
  assert.equal(typeof messages[0]?.localExecutionTimeMs, "number")
  assert.deepEqual(messages[0]?.hookAdditionalContexts.map(carrier => carrier.content), ["from the hook"])
})

test("a handler declines a message that is not its own", () => {
  const handler = new SimpleControlledExecHandler<ExecuteHookArgs, ExecuteHookResult>(
    { async execute() { return new ExecuteHookResult() } },
    createServerDeserializer("executeHookArgs"),
    createClientSerializer("executeHookResult"),
  )
  assert.equal(handler.handle(ctx(), new ExecServerMessage({ id: 1, message: { case: undefined } })), undefined)
})

test("a streaming handler yields each event and then the conflicts it collected", async () => {
  const handler = new SimpleControlledStreamExecHandler<ExecuteHookArgs, string>(
    {
      async *execute(_ctx, _args, options) {
        options.hookContextCollector.push(hookCarrier("a note", "preToolUse"))
        options.hookContextCollector.push(hookCarrier("a conflict", "agentStoreConflict"))
        yield "one"
        yield "two"
      },
    },
    createServerDeserializer("executeHookArgs"),
    (id, event) => new ExecClientMessage({ id, message: { case: undefined } }),
  )
  const messages = await collect(handler.handle(ctx(), serverMessageFor(2))!)
  assert.equal(messages.length, 3)
  assert.equal(messages[0]?.localExecutionTimeMs !== undefined, true)
  assert.deepEqual(messages[2]?.hookAdditionalContexts.map(carrier => carrier.content), ["a conflict"])
})

test("a manager asks its handlers in order and the first one that answers takes the call", async () => {
  const manager = new SimpleControlledExecManager()
  const declining = new SimpleControlledExecHandler<ExecuteHookArgs, ExecuteHookResult>(
    { async execute() { return new ExecuteHookResult() } },
    () => undefined,
    createClientSerializer("executeHookResult"),
  )
  const accepting = new SimpleControlledExecHandler<ExecuteHookArgs, ExecuteHookResult>(
    { async execute() { return new ExecuteHookResult() } },
    createServerDeserializer("executeHookArgs"),
    createClientSerializer("executeHookResult"),
  )
  manager.register(declining)
  manager.register(accepting)
  const messages = await collect(manager.handle(ctx(), serverMessageFor(8)))
  assert.equal(messages.at(-1)?.message.case, "streamClose")
  assert.equal(messages.some(message => message.message.case === "executeHookResult"), true)
})

test("an operation that fails reports the failure as data, with its code and stack", async () => {
  const manager = new SimpleControlledExecManager()
  manager.register(new SimpleControlledExecHandler<ExecuteHookArgs, ExecuteHookResult>(
    {
      async execute() {
        throw new ControlledExecDisposedError("the runtime is gone")
      },
    },
    createServerDeserializer("executeHookArgs"),
    createClientSerializer("executeHookResult"),
  ))
  const messages = await collect(manager.handle(ctx(), serverMessageFor(9)))
  const thrown = messages.find(message => message.message.case === "throw")
  assert.ok(thrown)
  const value = (thrown as ExecClientControlMessage & { message: { value: { error: string; stackTrace?: string; errorCode?: string } } }).message.value
  assert.equal(value.error, "the runtime is gone")
  assert.equal(value.errorCode, "EXEC_BACKEND_UNAVAILABLE")
  assert.equal(typeof value.stackTrace, "string")
})

test("a failure that is not an Error is still reported", async () => {
  const manager = new SimpleControlledExecManager()
  manager.register(new SimpleControlledExecHandler<ExecuteHookArgs, ExecuteHookResult>(
    {
      async execute() {
        throw "a bare string"
      },
    },
    createServerDeserializer("executeHookArgs"),
    createClientSerializer("executeHookResult"),
  ))
  const messages = await collect(manager.handle(ctx(), serverMessageFor(1)))
  const thrown = messages.find(message => message.message.case === "throw") as ExecClientControlMessage & { message: { value: { error: string } } }
  assert.equal(thrown.message.value.error, "Unknown error")
})

test("a message no handler knows is answered with a failure and a close", async () => {
  const messages = await collect(new SimpleControlledExecManager().handle(ctx(), serverMessageFor(3)))
  assert.deepEqual(messages.map(message => message.message.case), ["throw", "streamClose"])
  const thrown = messages[0] as ExecClientControlMessage & { message: { value: { id: number; error: string } } }
  assert.equal(thrown.message.value.id, 3)
  assert.match(thrown.message.value.error, /No handler found for server message of type executeHookArgs/)
})

test("git diagnostics are added to a failure when the manager was configured for them", async () => {
  const manager = new SimpleControlledExecManager({ includeGitStderrInThrows: true })
  manager.register(new SimpleControlledExecHandler<ExecuteHookArgs, ExecuteHookResult>(
    {
      async execute() {
        throw Object.assign(new Error("command failed"), { exitCode: 128, stderr: "fatal: no upstream" })
      },
    },
    createServerDeserializer("executeHookArgs"),
    createClientSerializer("executeHookResult"),
  ))
  const messages = await collect(manager.handle(ctx(), serverMessageFor(5)))
  const thrown = messages.find(message => message.message.case === "throw") as ExecClientControlMessage & { message: { value: { error: string } } }
  assert.match(thrown.message.value.error, /\[git: exitCode=128\]/)
  assert.match(thrown.message.value.error, /--- git stderr ---/)
})

test("aborting a call cancels the context the operation is running under", async () => {
  const manager = new SimpleControlledExecManager()
  let sawAbort = false
  manager.register(new SimpleControlledExecHandler<ExecuteHookArgs, ExecuteHookResult>(
    {
      async execute(context) {
        await new Promise<void>(resolve => {
          context.signal.addEventListener("abort", () => {
            sawAbort = true
            resolve()
          }, { once: true })
        })
        return new ExecuteHookResult()
      },
    },
    createServerDeserializer("executeHookArgs"),
    createClientSerializer("executeHookResult"),
  ))
  const stream = manager.handle(ctx(), serverMessageFor(12))
  const drained = collect(stream)
  await new Promise(resolve => setTimeout(resolve, 5))
  manager.handleControlMessage({
    message: { case: "abort", value: { id: 12 } },
  } as unknown as Parameters<typeof manager.handleControlMessage>[0])
  await drained
  assert.equal(sawAbort, true)
})

test("a manager built from a registry can serve what the registry holds", async () => {
  const registry = new RegistryResourceAccessor()
  const resource = createResource<{ label: string }, unknown, SimpleControlledExecManager>(
    () => ({ label: "remote" }),
    (implementation, manager) => manager.register(new SimpleControlledExecHandler(
      { async execute() { return new ExecuteHookResult() } },
      createServerDeserializer("executeHookArgs"),
      createClientSerializer("executeHookResult"),
    )),
  )
  registry.register(resource, { label: "local" })
  const manager = SimpleControlledExecManager.fromResources(registry)
  const messages = await collect(manager.handle(ctx(), serverMessageFor(6)))
  assert.equal(messages.some(message => message.message.case === "executeHookResult"), true)
})

// ---------------------------------------------------------------------------------------------
// agent-exec: the hook operation, end to end
// ---------------------------------------------------------------------------------------------

test("a hook call round-trips through both sides of the channel", async () => {
  const registry = new RegistryResourceAccessor()
  const resource = createResource<Executor<ExecuteHookArgs, ExecuteHookResult>, RemoteExecManager, SimpleControlledExecManager>(
    manager => new ExecutorResource(
      manager,
      createServerSerializer("executeHookArgs"),
      createClientDeserializer("executeHookResult"),
    ),
    (implementation, manager) => manager.register(new SimpleControlledExecHandler(
      implementation,
      createServerDeserializer("executeHookArgs"),
      createClientSerializer("executeHookResult"),
    )),
  )
  let executions = 0
  registry.register(resource, {
    async execute() {
      executions += 1
      return new ExecuteHookResult()
    },
  })
  // The host serves what the registry holds; the client reaches it over an exec instance.
  const serving = SimpleControlledExecManager.fromResources(registry)
  const client = new RemoteResourceAccessor<RemoteExecManager>({
    createExecInstance(context, createMessage) {
      return (async function* () {
        for await (const message of serving.handle(context, createMessage(21))) yield message as ExecClientMessage
      })()
    },
  })

  const result = await client.get(resource).execute(ctx(), new ExecuteHookArgs())
  assert.ok(result instanceof ExecuteHookResult)
  assert.equal(executions, 1)
})

test("the hook operation is registered under its own name and is the same everywhere", () => {
  assert.equal(typeof hookExecutorResource.symbol, "symbol")
  const client = new RemoteResourceAccessor<RemoteExecManager>(fakeExecManager({ messages: [] }))
  assert.ok(client.get(hookExecutorResource) instanceof ExecutorResource)
})
