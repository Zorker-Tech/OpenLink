import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HostExtensionGraphError,
  HostExtensionStartError,
  createHostEvents,
  defineHostExtension,
  resolveHostExtensionBootOrder,
  startHostExtensions,
} from "../../source/host/extensions/host-extensions.ts";

/** One extension that records that it started, and whatever it asked to have torn down. */
function extension(id: string, dependencies: readonly string[] = [], log: string[] = []) {
  return defineHostExtension<{ readonly id: string }, { log(message: string): void }>({
    id,
    dependencies,
    start: ({ deps, onStop }) => {
      log.push(`start ${id}`);
      onStop(() => {
        log.push(`stop ${id}`);
      });
      return { id: `${id}:${Object.keys(deps).sort().join("+")}` };
    },
  });
}

describe("declaring an extension", () => {
  it("marks the declaration as a host extension and freezes it", () => {
    const declaration = extension("audit");
    assert.equal(declaration.kind, "host-extension");
    assert.equal(declaration.id, "audit");
    assert.equal(Object.isFrozen(declaration), true);
    assert.equal(Object.isFrozen(declaration.dependencies), true);
  });

  it("keeps its own copy of the peers it was declared with", () => {
    const peers = ["a", "b"];
    const declaration = defineHostExtension({ id: "c", dependencies: peers, start: () => ({}) });
    peers.push("d");
    assert.deepEqual(declaration.dependencies, ["a", "b"]);
  });
});

describe("the boot order", () => {
  it("puts every extension after the peers it names", () => {
    const order = resolveHostExtensionBootOrder([extension("c", ["b"]), extension("b", ["a"]), extension("a")]);
    assert.deepEqual(order, ["a", "b", "c"]);
  });

  it("takes the first one by id when several are ready at once", () => {
    assert.deepEqual(resolveHostExtensionBootOrder([extension("z"), extension("m"), extension("b")]), ["b", "m", "z"]);
    const order = resolveHostExtensionBootOrder([extension("late", ["middle"]), extension("middle"), extension("early")]);
    assert.deepEqual(order, ["early", "middle", "late"]);
  });

  it("answers an empty set with an empty order", () => {
    assert.deepEqual(resolveHostExtensionBootOrder([]), []);
  });

  it("refuses two extensions with the same id", () => {
    assert.throws(() => resolveHostExtensionBootOrder([extension("dup"), extension("dup")]), {
      name: "HostExtensionGraphError",
      message: /two host extensions declare the id "dup"/,
    });
  });

  it("refuses an extension that waits on itself", () => {
    assert.throws(() => resolveHostExtensionBootOrder([extension("loop", ["loop"])]), {
      name: "HostExtensionGraphError",
      message: /"loop" declares itself as a peer/,
    });
  });

  it("refuses a peer this build does not contain", () => {
    assert.throws(() => resolveHostExtensionBootOrder([extension("needy", ["absent"])]), {
      name: "HostExtensionGraphError",
      message: /requires the peer "absent", which is not in this build/,
    });
  });

  it("names the path around a cycle", () => {
    assert.throws(() => resolveHostExtensionBootOrder([extension("a", ["c"]), extension("b", ["a"]), extension("c", ["b"])]), {
      name: "HostExtensionGraphError",
      message: /host extension peer cycle: a → c → b → a/,
    });
  });

  it("reports the cycle rather than the extensions it already ordered", () => {
    assert.throws(() => resolveHostExtensionBootOrder([extension("first"), extension("x", ["y"]), extension("y", ["x"])]), {
      message: /host extension peer cycle: x → y → x/,
    });
  });
});

describe("starting the extensions", () => {
  it("starts them in order and hands each one the api of the peers it named", async () => {
    const log: string[] = [];
    const started = await startHostExtensions({
      extensions: [extension("c", ["b"], log), extension("a", [], log), extension("b", ["a"], log)],
      host: { log: (message: string) => log.push(`host:${message}`) },
      onStopFailure: (id, error) => log.push(`stop failed ${id}: ${String(error)}`),
    });
    assert.deepEqual(started.order, ["a", "b", "c"]);
    assert.deepEqual(started.apis, { a: { id: "a:" }, b: { id: "b:a" }, c: { id: "c:b" } });
    assert.deepEqual(log, ["start a", "start b", "start c"]);
  });

  it("stops what it started, newest first, when the caller asks it to", async () => {
    const log: string[] = [];
    const started = await startHostExtensions({
      extensions: [extension("a", [], log), extension("b", ["a"], log), extension("c", ["b"], log)],
      host: { log() {} },
      onStopFailure: (id, error) => log.push(`stop failed ${id}: ${String(error)}`),
    });
    await started.stop();
    assert.deepEqual(log.slice(3), ["stop c", "stop b", "stop a"]);
  });

  it("stops only once when asked twice, and stops nothing if it never started", async () => {
    const log: string[] = [];
    const started = await startHostExtensions({ extensions: [extension("a", [], log)], host: { log() {} }, onStopFailure: (id) => log.push(`failed ${id}`) });
    await started.stop();
    await started.stop();
    assert.deepEqual(log, ["start a", "stop a"]);
  });

  it("reports a teardown that fails and keeps tearing the rest down", async () => {
    const reported: string[] = [];
    const stopped: string[] = [];
    const started = await startHostExtensions({
      extensions: [
        defineHostExtension({ id: "a", dependencies: [], start: ({ onStop }) => {
          onStop(() => {
            stopped.push("a");
          });
          return {};
        } }),
        defineHostExtension({ id: "b", dependencies: ["a"], start: ({ onStop }) => { onStop(() => { throw new Error("b refused to stop"); }); return {}; } }),
        defineHostExtension({ id: "c", dependencies: ["b"], start: ({ onStop }) => {
          onStop(() => {
            stopped.push("c");
          });
          return {};
        } }),
      ],
      host: { log() {} },
      onStopFailure: (id, error) => reported.push(`${id}:${(error as Error).message}`),
    });
    await started.stop();
    assert.deepEqual(reported, ["b:b refused to stop"]);
    assert.deepEqual(stopped, ["c", "a"]);
  });

  it("stops what it already started when one of them fails, and reports which one", async () => {
    const log: string[] = [];
    const promise = startHostExtensions({
      extensions: [
        defineHostExtension({ id: "a", dependencies: [], start: ({ onStop }) => {
          log.push("start a");
          onStop(() => {
            log.push("stop a");
          });
          return {};
        } }),
        defineHostExtension({ id: "b", dependencies: ["a"], start: () => { log.push("start b"); throw new Error("no port to listen on"); } }),
        defineHostExtension({ id: "c", dependencies: ["b"], start: () => { log.push("start c"); return {}; } }),
      ],
      host: { log() {} },
      onStopFailure: (id, error) => log.push(`stop failed ${id}: ${String(error)}`),
    });
    await assert.rejects(promise, (error: unknown) => {
      assert.equal(error instanceof HostExtensionStartError, true);
      assert.equal((error as HostExtensionStartError).extensionId, "b");
      assert.equal((error as Error).message, 'host extension "b" failed to start');
      assert.equal(((error as Error).cause as Error).message, "no port to listen on");
      return true;
    });
    assert.deepEqual(log, ["start a", "start b", "stop a"]);
  });

  it("refuses a set it cannot order before starting any of it", async () => {
    const log: string[] = [];
    await assert.rejects(
      startHostExtensions({ extensions: [extension("a", ["b"], log), extension("b", ["a"], log)], host: { log() {} }, onStopFailure: () => {
        log.push("stop failed");
      } }),
      HostExtensionGraphError,
    );
    assert.deepEqual(log, []);
  });
});

describe("the topic bus", () => {
  it("tells every subscriber, and reports each one that failed without stopping the others", async () => {
    const reported: string[] = [];
    const seen: string[] = [];
    const bus = createHostEvents({ onHandlerFailure: (topic, error) => reported.push(`${topic}:${(error as Error).message}`) });
    bus.on("chat", (payload) => seen.push(`one:${String(payload)}`));
    bus.on("chat", () => {
      throw new Error("two broke");
    });
    bus.on("chat", async () => {
      await Promise.resolve();
      throw new Error("three broke");
    });
    await bus.emit("chat", "hi");
    assert.deepEqual(seen, ["one:hi"]);
    assert.deepEqual(reported.sort(), ["chat:three broke", "chat:two broke"].sort());
  });

  it("throws the first failure when the emit asked for it, after reporting every one", async () => {
    const reported: string[] = [];
    const bus = createHostEvents({ onHandlerFailure: (_topic, error) => reported.push((error as Error).message) });
    bus.on("t", () => {
      throw new Error("first");
    });
    bus.on("t", () => {
      throw new Error("second");
    });
    await assert.rejects(bus.emit("t", 1, { failureMode: "reject" }), /first|second/);
    assert.deepEqual(reported.sort(), ["first", "second"]);
  });

  it("does nothing when nobody is listening", async () => {
    const bus = createHostEvents({ onHandlerFailure: () => assert.fail("nothing to report") });
    await bus.emit("quiet", 1);
    await bus.emit("quiet", 1, { failureMode: "reject" });
  });

  it("stops telling a subscriber once it unsubscribed, however many times it unsubscribes", async () => {
    const seen: string[] = [];
    const bus = createHostEvents({ onHandlerFailure: () => {} });
    const off = bus.on("t", (payload) => seen.push(String(payload)));
    await bus.emit("t", "first");
    off();
    off();
    await bus.emit("t", "second");
    assert.deepEqual(seen, ["first"]);
  });

  it("tells a subscriber added during an emit from the next emit on", async () => {
    const seen: string[] = [];
    const bus = createHostEvents({ onHandlerFailure: () => {} });
    bus.on("t", () => {
      seen.push("first");
      bus.on("t", () => seen.push("late"));
    });
    await bus.emit("t", 1);
    assert.deepEqual(seen, ["first"]);
    seen.length = 0;
    await bus.emit("t", 2);
    assert.deepEqual(seen.sort(), ["first", "late"]);
  });
});
