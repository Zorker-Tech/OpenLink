import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MethodKind } from "@bufbuild/protobuf";

import { createContextPropagatingClient } from "../../source/packages/context-rpc/index.ts";
import { createContext } from "../../source/packages/context/context.ts";

const ctx = createContext();
const service = {
  typeName: "probe.ProbeService",
  methods: {
    echo: { name: "echo", kind: MethodKind.Unary, I: {}, O: {} },
    watch: { name: "watch", kind: MethodKind.ServerStreaming, I: {}, O: {} },
  },
} as never;

function fakeTransport(overrides: Record<string, unknown> = {}) {
  const calls: any[] = [];
  const transport = {
    async unary(_service: unknown, method: any, signal: any, timeoutMs: any, headers: Headers, input: unknown, contextValues: unknown) {
      calls.push({ kind: "unary", method: method.name, signal, timeoutMs, headers, input, contextValues });
      if (overrides.unaryError !== undefined) throw overrides.unaryError;
      if (overrides.waitForAbort === true) {
        return await new Promise((resolve) => {
          if (signal.aborted) resolve({ message: { aborted: true }, header: new Headers(), trailer: new Headers() });
          else signal.addEventListener("abort", () => resolve({ message: { aborted: true }, header: new Headers(), trailer: new Headers() }), { once: true });
        });
      }
      return { message: { echoed: input }, header: new Headers(), trailer: new Headers() };
    },
    stream(_service: unknown, method: any, signal: any, timeoutMs: any, headers: Headers, input: unknown, contextValues: unknown) {
      calls.push({ kind: "stream", method: method.name, signal, timeoutMs, headers, input, contextValues });
      async function* values() {
        yield { index: 1 };
        yield { index: 2 };
      }
      return { message: values(), header: new Headers(), trailer: new Headers() };
    },
  };
  return { calls, transport: transport as never };
}

describe("calling the backend with the request context", () => {
  it("passes the input through and extracts the caller headers", async () => {
    const world = fakeTransport();
    const client: any = createContextPropagatingClient(service, world.transport, {
      injectTraceHeaders: false,
      extractHeaders: () => new Headers({ "x-caller": "one" }),
    });
    const result = await client.echo(ctx, { text: "hi" }, {});
    assert.deepEqual(result, { echoed: { text: "hi" } });
    assert.equal(world.calls.length, 1);
    assert.equal(world.calls[0].method, "echo");
    assert.equal(world.calls[0].headers.get("x-caller"), "one");
    assert.equal(world.calls[0].input.text, "hi");
  });

  it("merges the abort signals when asked", async () => {
    const world = fakeTransport({ waitForAbort: true });
    const client: any = createContextPropagatingClient(service, world.transport, { enableAbortSignal: true });
    const controller = new AbortController();
    const call = client.echo(ctx, {}, { signal: controller.signal });
    const forwarded = world.calls[0].signal as AbortSignal;
    assert.notEqual(forwarded, controller.signal);
    assert.equal(forwarded.aborted, false);
    controller.abort(new Error("stop"));
    assert.equal(forwarded.aborted, true);
    assert.deepEqual(await call, { aborted: true });
  });

  it("keeps the caller signal when abort forwarding is off", async () => {
    const world = fakeTransport();
    const client: any = createContextPropagatingClient(service, world.transport, { enableAbortSignal: false });
    const controller = new AbortController();
    await client.echo(ctx, {}, { signal: controller.signal });
    assert.equal(world.calls[0].signal, controller.signal);
  });

  it("wraps a server stream and yields its messages", async () => {
    const world = fakeTransport();
    const client: any = createContextPropagatingClient(service, world.transport, {});
    const seen: unknown[] = [];
    for await (const message of client.watch(ctx, {})) seen.push(message);
    assert.deepEqual(seen, [{ index: 1 }, { index: 2 }]);
    assert.equal(world.calls[0].kind, "stream");
  });

  it("rejects when the transport refuses", async () => {
    const failure = new Error("backend refused");
    const world = fakeTransport({ unaryError: failure });
    const client: any = createContextPropagatingClient(service, world.transport, {});
    await assert.rejects(() => client.echo(ctx, {}, {}), /backend refused/);
  });
});
