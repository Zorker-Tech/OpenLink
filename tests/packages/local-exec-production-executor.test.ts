/**
 * The local-exec daemon's executor as it is built for a real machine.
 *
 * What is pinned here is the assembly rather than the operations it delegates to: which bindings production insists on
 * (and in which order it names them), that the generic factory passes the root, the file limit, the codec and the
 * context through exactly once per call, that the first-party executor wires the generated classes, the machine's root
 * and the file-size gate together, and which answers the daemon gives when a path is refused, a file is too large, a
 * working directory is missing, or a message cannot be decoded.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import type { LocalExecExecutor, LocalExecExecutorOutput } from "../../source/host/local-exec/local-exec-provider.ts";
import { DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES, localExecFileTooLargeMessage } from "../../source/shared/local-exec-gateway.ts";
import {
  assertProductionLocalExecRuntime,
  createDefaultProductionLocalExecExecutor,
  createProductionLocalExecExecutor,
  ProductionLocalExecCompositionError,
  PRODUCTION_LOCAL_EXEC_RUNTIME_BINDINGS,
} from "../../source/local-exec/production-executor.ts";

// ---------------------------------------------------------------------------------------------
// The runtime production insists on
// ---------------------------------------------------------------------------------------------

const CODEC_METHODS = [
  "decodeServerMessage",
  "toManagerMessage",
  "isClientMessage",
  "clientMessageToJson",
  "controlMessageToJson",
  "createAbortControl",
  "createThrowControl",
] as const;

/** A runtime that carries every binding, so the assertion accepts it. */
function completeRuntime(): Record<string, unknown> {
  return {
    managerRuntime: { build: () => ({}) },
    codec: Object.fromEntries(CODEC_METHODS.map((method) => [method, () => ({})])),
    createContext: () => ({ withCancel: () => [] }),
  };
}

test("names the nine bindings production cannot be built without", () => {
  assert.deepEqual(Array.from(PRODUCTION_LOCAL_EXEC_RUNTIME_BINDINGS), [
    "managerRuntime.build",
    "codec.decodeServerMessage",
    "codec.toManagerMessage",
    "codec.isClientMessage",
    "codec.clientMessageToJson",
    "codec.controlMessageToJson",
    "codec.createAbortControl",
    "codec.createThrowControl",
    "createContext",
  ]);
  assert.equal(Object.isFrozen(PRODUCTION_LOCAL_EXEC_RUNTIME_BINDINGS), true);
});

test("a composition error names the bindings it is missing", () => {
  const error = new ProductionLocalExecCompositionError(["managerRuntime.build", "createContext"]);
  assert.equal(error.name, "ProductionLocalExecCompositionError");
  assert.equal(
    error.message,
    "local-exec production runtime is missing mandatory bindings: managerRuntime.build, createContext",
  );
  assert.deepEqual(error.missingBindings, ["managerRuntime.build", "createContext"]);
  assert.equal(error instanceof Error, true);
});

test("a complete runtime is accepted and unrelated bindings are not looked at", () => {
  assert.doesNotThrow(() => assertProductionLocalExecRuntime(completeRuntime()));
  assert.doesNotThrow(() => assertProductionLocalExecRuntime({ ...completeRuntime(), extra: () => {} }));
});

test("every missing binding is reported in the order production names them", () => {
  const expected = Array.from(PRODUCTION_LOCAL_EXEC_RUNTIME_BINDINGS);
  const missingEverything = () => {
    const runtime = completeRuntime();
    delete (runtime.managerRuntime as Record<string, unknown>).build;
    const codec = runtime.codec as Record<string, unknown>;
    for (const method of CODEC_METHODS) delete codec[method];
    runtime.createContext = undefined;
    return runtime;
  };
  assert.throws(
    () => assertProductionLocalExecRuntime(missingEverything()),
    (error: unknown) => {
      assert.equal(error instanceof ProductionLocalExecCompositionError, true);
      assert.deepEqual((error as ProductionLocalExecCompositionError).missingBindings, expected);
      return true;
    },
  );

  // One binding at a time is named on its own, whatever kind of value is standing in for it.
  for (const binding of expected) {
    const runtime = completeRuntime();
    if (binding === "managerRuntime.build") (runtime.managerRuntime as Record<string, unknown>).build = "not a function";
    else if (binding === "createContext") runtime.createContext = 5;
    else (runtime.codec as Record<string, unknown>)[binding.slice("codec.".length)] = null;
    assert.throws(
      () => assertProductionLocalExecRuntime(runtime),
      (error: unknown) => {
        assert.deepEqual((error as ProductionLocalExecCompositionError).missingBindings, [binding]);
        return true;
      },
      binding,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// The generic factory
// ---------------------------------------------------------------------------------------------

interface FakeRuntimeTrace {
  readonly calls: string[];
}

/** A runtime and manager that record every call, so the factory's order and arguments are visible. */
function recordingRuntime(): {
  readonly runtime: Record<string, unknown>;
  readonly calls: string[];
  readonly started: { contexts: unknown[]; managerMessages: unknown[] };
} {
  const calls: string[] = [];
  const started: { contexts: unknown[]; managerMessages: unknown[] } = { contexts: [], managerMessages: [] };
  const manager = {
    handle(context: unknown, message: unknown) {
      started.contexts.push(context);
      started.managerMessages.push(message);
      return (async function* () {
        yield { token: "client-a" };
        yield { token: "control-b" };
      })();
    },
    handleControlMessage(message: unknown) {
      calls.push("handleControlMessage:" + JSON.stringify(message));
    },
  };
  const codec = {
    decodeServerMessage(json: unknown) {
      calls.push("decodeServerMessage:" + JSON.stringify(json));
      return { decoded: json };
    },
    toManagerMessage(message: unknown) {
      calls.push("toManagerMessage:" + JSON.stringify(message));
      return { managerMessage: message };
    },
    isClientMessage(message: { token?: string }) {
      return message?.token?.startsWith("client") === true;
    },
    clientMessageToJson(message: unknown) {
      return { wire: "client", message };
    },
    controlMessageToJson(message: unknown) {
      return { wire: "control", message };
    },
    createAbortControl(execId: unknown) {
      return { abort: execId };
    },
    createThrowControl(execId: unknown, error: unknown) {
      return { throw: execId, error };
    },
  };
  const managerRuntime = {
    build(root: unknown, maxFileBytes: unknown, guards: unknown) {
      calls.push("build:" + JSON.stringify([root, maxFileBytes, Object.keys(guards as object).sort()]));
      return manager;
    },
  };
  const runtime = {
    managerRuntime,
    codec,
    createContext(signal: AbortSignal) {
      calls.push("createContext:" + signal.aborted);
      return { cancelled: signal.aborted };
    },
  };
  return { runtime, calls, started };
}

/** A throw control names the exec id and the error; the manager also stamps a stack, which belongs to the caller's file. */
function throwControlOf(message: unknown): { id: number; error: string } {
  const control = message as { throw: { id: number; error: string } };
  assert.deepEqual(Object.keys(control), ["throw"]);
  return { id: control.throw.id, error: control.throw.error };
}

async function collectOutputs(executor: LocalExecExecutor, decoded: unknown, signal: AbortSignal): Promise<LocalExecExecutorOutput[]> {
  const outputs: LocalExecExecutorOutput[] = [];
  for await (const output of executor.execute(decoded as never, signal)) outputs.push(output);
  return outputs;
}

test("builds the machine's manager over the root and file size it was given", () => {
  const { runtime, calls } = recordingRuntime();
  createProductionLocalExecExecutor({
    runtime: runtime as never,
    root: "/fake/machine",
    maxFileBytes: 42,
  });

  assert.deepEqual(calls, [
    'build:["/fake/machine",42,["containPath","missingWorkingDirectoryNotice","regularFileSizeBytes","resolveShellWorkingDirectory"]]',
  ]);
});

test("defaults the root to this machine and the file size to the daemon's limit", () => {
  const previousRoot = process.env.SLATE_LOCAL_EXEC_ROOT;
  process.env.SLATE_LOCAL_EXEC_ROOT = "/fake/default-root";
  try {
    const { runtime, calls } = recordingRuntime();
    createProductionLocalExecExecutor({ runtime: runtime as never });
    assert.deepEqual(calls, [
      'build:["/fake/default-root",' + DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES + ',["containPath","missingWorkingDirectoryNotice","regularFileSizeBytes","resolveShellWorkingDirectory"]]',
    ]);
  } finally {
    if (previousRoot === undefined) delete process.env.SLATE_LOCAL_EXEC_ROOT;
    else process.env.SLATE_LOCAL_EXEC_ROOT = previousRoot;
  }
});

test("passes a decoded message through the codec and answers in the codec's JSON", async () => {
  const { runtime, calls, started } = recordingRuntime();
  const executor = createProductionLocalExecExecutor({ runtime: runtime as never, root: "/fake/machine", maxFileBytes: 42 });
  calls.length = 0;

  const decoded = executor.decodeServerMessage({ hello: 1 });
  assert.deepEqual(decoded, { decoded: { hello: 1 } });

  const controller = new AbortController();
  const outputs = await collectOutputs(executor, decoded, controller.signal);

  assert.deepEqual(outputs, [
    { kind: "client", message: { wire: "client", message: { token: "client-a" } } },
    { kind: "control", message: { wire: "control", message: { token: "control-b" } } },
  ]);
  assert.deepEqual(calls, ['decodeServerMessage:{"hello":1}', "createContext:false", 'toManagerMessage:{"decoded":{"hello":1}}']);
  assert.deepEqual(started.contexts, [{ cancelled: false }]);
  assert.deepEqual(started.managerMessages, [{ managerMessage: { decoded: { hello: 1 } } }]);
});

test("does not reach the manager until the stream is read", () => {
  const { runtime, calls, started } = recordingRuntime();
  const executor = createProductionLocalExecExecutor({ runtime: runtime as never, root: "/fake/machine", maxFileBytes: 42 });
  calls.length = 0;

  const stream = executor.execute({ lazy: true } as never, new AbortController().signal);
  assert.deepEqual(calls, []);
  assert.deepEqual(started.contexts, []);
  void stream;
});

test("a run is cancelled through an abort control for its exec id", () => {
  const { runtime, calls } = recordingRuntime();
  const executor = createProductionLocalExecExecutor({ runtime: runtime as never, root: "/fake/machine", maxFileBytes: 42 });
  calls.length = 0;

  assert.equal(executor.cancel(7), undefined);
  assert.deepEqual(calls, ['handleControlMessage:{"abort":7}']);
});

test("a throw is reported as a control message for exec id zero", () => {
  const { runtime } = recordingRuntime();
  const executor = createProductionLocalExecExecutor({ runtime: runtime as never, root: "/fake/machine", maxFileBytes: 42 });

  assert.deepEqual(executor.throwControl("refused"), { wire: "control", message: { throw: 0, error: "refused" } });
});

test("a runtime that cannot carry production is refused before the manager is built", () => {
  const { runtime, calls } = recordingRuntime();
  assert.throws(
    () => createProductionLocalExecExecutor({ runtime: { ...runtime, createContext: undefined } as never }),
    (error: unknown) => {
      assert.equal(error instanceof ProductionLocalExecCompositionError, true);
      assert.deepEqual((error as ProductionLocalExecCompositionError).missingBindings, ["createContext"]);
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test("what the manager already answered survives a failure in the run", async () => {
  const { runtime, calls } = recordingRuntime();
  (runtime.managerRuntime as { build: unknown }).build = () => ({
    handle() {
      return (async function* () {
        yield { token: "client-before-failure" };
        throw new Error("manager exploded");
      })();
    },
    handleControlMessage() {},
  });
  const executor = createProductionLocalExecExecutor({ runtime: runtime as never, root: "/fake/machine", maxFileBytes: 42 });
  calls.length = 0;

  const outputs: LocalExecExecutorOutput[] = [];
  await assert.rejects(
    async () => {
      for await (const output of executor.execute({ id: 1 } as never, new AbortController().signal)) outputs.push(output);
    },
    (error: unknown) => {
      assert.equal((error as Error).message, "manager exploded");
      return true;
    },
  );
  assert.deepEqual(outputs, [
    { kind: "client", message: { wire: "client", message: { token: "client-before-failure" } } },
  ]);
});

// ---------------------------------------------------------------------------------------------
// The first-party executor
// ---------------------------------------------------------------------------------------------

function withMachine(run: (machine: string) => Promise<void>): Promise<void> {
  const machine = mkdtempSync(join(tmpdir(), "slate-production-executor-"));
  return run(machine).finally(() => rmSync(machine, { recursive: true, force: true }));
}

test("decodes a generated server message and keeps the id it was decoded with", () => {
  return withMachine(async (machine) => {
    const executor = createDefaultProductionLocalExecExecutor({ root: machine });
    const decoded = executor.decodeServerMessage({ id: 3, readArgs: { path: "notes.txt" }, unknownField: "ignored" });

    assert.equal(decoded.message?.case, "readArgs");
    assert.deepEqual(Object.keys(decoded), ["generated"]);

    decoded.id = 77;
    assert.equal((decoded as unknown as { generated: { id: number } }).generated.id, 77);
    assert.equal(decoded.id, 77);

    // A oneof that was sent with no payload still names its case, and carries no value.
    const emptyArgs = executor.decodeServerMessage({ id: 9, readArgs: null });
    assert.equal(emptyArgs.message?.case, "readArgs");
    assert.equal(emptyArgs.message?.value, undefined);

    // A message that names no oneof case has no case to report, and no value either.
    const noCase = executor.decodeServerMessage({ id: 10 });
    assert.deepEqual(noCase.message, {});
  });
});

test("refuses to hand the manager a message it did not decode", async () => {
  await withMachine(async (machine) => {
    const executor = createDefaultProductionLocalExecExecutor({ root: machine });
    await assert.rejects(
      () => collectOutputs(executor, { id: 1 }, new AbortController().signal),
      (error: unknown) => {
        assert.equal(error instanceof TypeError, true);
        assert.equal(error instanceof TypeError && error.message, "local-exec decoded message did not originate from the generated production codec");
        return true;
      },
    );
  });
});

test("reads a file through the machine it was built for", async () => {
  await withMachine(async (machine) => {
    writeFileSync(join(machine, "notes.txt"), "one\n");
    const executor = createDefaultProductionLocalExecExecutor({ root: machine });
    const outputs = await collectOutputs(
      executor,
      executor.decodeServerMessage({ id: 5, readArgs: { path: "notes.txt" } }),
      new AbortController().signal,
    );

    assert.equal(outputs[0]?.kind, "client");
    assert.equal(outputs[1]?.kind, "control");
    const result = outputs[0]?.message as { id: number; readResult: { success: { path: string; content: string; fileSize: string } } };
    assert.equal(result.id, 5);
    assert.equal(result.readResult.success.path, resolve(machine, "notes.txt"));
    assert.equal(result.readResult.success.content, "one\n");
    assert.equal(result.readResult.success.fileSize, "4");
    assert.deepEqual(outputs[1]?.message, { streamClose: { id: 5 } });
  });
});

test("a file over the daemon's limit is refused before it is read, and one at the limit is read", async () => {
  await withMachine(async (machine) => {
    writeFileSync(join(machine, "over.txt"), "12345");
    writeFileSync(join(machine, "at-limit.txt"), "1234");
    const executor = createDefaultProductionLocalExecExecutor({ root: machine, maxFileBytes: 4 });

    const over = await collectOutputs(
      executor,
      executor.decodeServerMessage({ id: 1, readArgs: { path: "over.txt" } }),
      new AbortController().signal,
    );
    const refusal = over[0]?.message as { id: number; readResult: unknown };
    assert.equal(refusal.id, 1);
    assert.deepEqual(refusal.readResult, {
      error: { path: resolve(machine, "over.txt"), error: localExecFileTooLargeMessage(5, 4) },
    });

    const atLimit = await collectOutputs(
      executor,
      executor.decodeServerMessage({ id: 2, readArgs: { path: "at-limit.txt" } }),
      new AbortController().signal,
    );
    assert.equal((atLimit[0]?.message as { readResult: { success?: { content: string } } }).readResult.success?.content, "1234");

    // The answer says which number is the file and which is the limit, so a larger pair whose sizes read differently
    // proves the two are not swapped.
    const twoMiB = 2 * 1024 * 1024 + 1;
    writeFileSync(join(machine, "two-mib.txt"), Buffer.alloc(twoMiB));
    const big = createDefaultProductionLocalExecExecutor({ root: machine, maxFileBytes: 1024 * 1024 });
    const bigRefusal = await collectOutputs(
      big,
      big.decodeServerMessage({ id: 3, readArgs: { path: "two-mib.txt" } }),
      new AbortController().signal,
    );
    const bigError = (bigRefusal[0]?.message as { readResult: { error: { error: string } } }).readResult.error.error;
    assert.equal(bigError, localExecFileTooLargeMessage(twoMiB, 1024 * 1024));
    assert.match(bigError, /File is 2\.0 MiB, which exceeds Slate's 1\.0 MiB limit/);
  });
});

test("a directory is handed to the reader rather than sized as a file", async () => {
  await withMachine(async (machine) => {
    mkdirSync(join(machine, "a-directory"));
    const executor = createDefaultProductionLocalExecExecutor({ root: machine });
    const outputs = await collectOutputs(
      executor,
      executor.decodeServerMessage({ id: 3, readArgs: { path: "a-directory" } }),
      new AbortController().signal,
    );

    const result = outputs[0]?.message as { readResult: { invalidFile?: { reason: string } } };
    assert.match(result.readResult.invalidFile?.reason ?? "", /is a directory/);
  });
});

test("a path outside the machine's root is refused", async () => {
  await withMachine(async (machine) => {
    const executor = createDefaultProductionLocalExecExecutor({ root: machine });
    const outputs = await collectOutputs(
      executor,
      executor.decodeServerMessage({ id: 4, readArgs: { path: "../outside.txt" } }),
      new AbortController().signal,
    );

    assert.equal(outputs.length, 1);
    assert.deepEqual(throwControlOf(outputs[0]?.message), {
      id: 4,
      error: "Path is outside the allowed local-exec root and was refused: ../outside.txt",
    });
  });
});

test("a missing working directory is reported before the command runs in the machine's root", async () => {
  await withMachine(async (machine) => {
    const executor = createDefaultProductionLocalExecExecutor({ root: machine });
    const controller = new AbortController();
    controller.abort(new Error("stop-marker"));
    const outputs = await collectOutputs(
      executor,
      executor.decodeServerMessage({
        id: 9,
        shellStreamArgs: { command: "true", workingDirectory: "/definitely/not/here" },
      }),
      controller.signal,
    );

    // The note about the fall back arrives as a stream event, then the aborted run ends as a throw control.
    assert.equal((outputs[0]?.message as { shellStream: { stderr: { data: string } } }).shellStream.stderr.data,
      "working directory /definitely/not/here does not exist on this machine; running in " + machine + " instead\n");
    assert.deepEqual(throwControlOf(outputs[1]?.message), { id: 9, error: "stop-marker" });
  });
});

test("a shell command runs in the working directory that was settled for it", async () => {
  await withMachine(async (machine) => {
    mkdirSync(join(machine, "work"));
    const executor = createDefaultProductionLocalExecExecutor({ root: machine });
    const outputs = await collectOutputs(
      executor,
      executor.decodeServerMessage({ id: 6, shellStreamArgs: { command: "pwd", workingDirectory: "work" } }),
      new AbortController().signal,
    );

    const printed = outputs
      .map((output) => (output.message as { shellStream?: { stdout?: { data: string } } }).shellStream?.stdout?.data)
      .filter((data): data is string => data !== undefined)
      .join("");
    assert.equal(realpathSync(printed.trim()), realpathSync(join(machine, "work")));
  });
});

test("a command whose working directory is missing runs in the machine's root", async () => {
  await withMachine(async (machine) => {
    const executor = createDefaultProductionLocalExecExecutor({ root: machine });
    const outputs = await collectOutputs(
      executor,
      executor.decodeServerMessage({
        id: 12,
        shellStreamArgs: { command: "pwd", workingDirectory: "/definitely/not/here" },
      }),
      new AbortController().signal,
    );

    const notice = (outputs[0]?.message as { shellStream?: { stderr?: { data: string } } }).shellStream?.stderr?.data;
    assert.equal(notice, "working directory /definitely/not/here does not exist on this machine; running in " + machine + " instead\n");
    const printed = outputs
      .map((output) => (output.message as { shellStream?: { stdout?: { data: string } } }).shellStream?.stdout?.data)
      .filter((data): data is string => data !== undefined)
      .join("");
    assert.equal(realpathSync(printed.trim()), realpathSync(machine));
  });
});

test("a running command ends when the executor cancels it", async () => {
  await withMachine(async (machine) => {
    mkdirSync(join(machine, "work"));
    const executor = createDefaultProductionLocalExecExecutor({ root: machine });
    const decoded = executor.decodeServerMessage({ id: 21, shellStreamArgs: { command: "sleep 0.3", workingDirectory: "work" } });
    const outputs: LocalExecExecutorOutput[] = [];
    for await (const output of executor.execute(decoded, new AbortController().signal)) {
      outputs.push(output);
      if (outputs.length === 1) executor.cancel(decoded.id);
    }

    const last = outputs.at(-1)?.message as { throw?: { id: number }; shellStream?: { exit?: { aborted?: boolean } } };
    const endedByAbort = last.throw?.id === 21 || last.shellStream?.exit?.aborted === true;
    assert.equal(endedByAbort, true, "a cancelled command ends as an abort rather than running to completion");
  });
});

test("an unsupported server message is answered with a throw and a stream close", async () => {
  await withMachine(async (machine) => {
    const executor = createDefaultProductionLocalExecExecutor({ root: machine });
    const outputs = await collectOutputs(executor, executor.decodeServerMessage({ id: 13 }), new AbortController().signal);

    assert.deepEqual(outputs.map((output) => output.kind), ["control", "control"]);
    assert.deepEqual(throwControlOf(outputs[0]?.message), { id: 13, error: "No handler found for server message of type undefined" });
    assert.deepEqual(outputs[1]?.message, { streamClose: { id: 13 } });
  });
});

test("the default executor is the four-method provider surface", async () => {
  await withMachine(async (machine) => {
    const executor = createDefaultProductionLocalExecExecutor({ root: machine });
    assert.deepEqual(Object.keys(executor), ["decodeServerMessage", "execute", "cancel", "throwControl"]);
    assert.equal(executor.decodeServerMessage.length, 1);
    assert.equal(executor.execute.length, 2);
    assert.equal(executor.cancel.length, 1);
    assert.equal(executor.throwControl.length, 1);
    assert.deepEqual(executor.throwControl("refused"), { throw: { error: "refused" } });
  });
});