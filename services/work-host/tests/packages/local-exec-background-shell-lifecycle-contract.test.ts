import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BackgroundShellManager,
  ConversationOwnerOverrideRegistry,
  CoreBackgroundShell,
} from "../../source/packages/local-exec/background-shell-lifecycle.ts";

function harness() {
  const work: any[] = [];
  const shells = new Map<number, any>();
  let nextId = 1_000;
  const registry = {
    enqueue: (notice: any) => work.push(["enqueue", notice]),
    upsertWork: (record: any) => work.push(["upsert", record]),
    clearWork: (id: string) => work.push(["clear", id]),
    abortWork: () => false,
    hasRunningWork: () => shells.size > 0,
    abortAllWork: () => 0,
    listWork: () => [],
    pull: () => [],
    ack: () => [],
    nack: () => undefined,
    suppress: () => undefined,
    drainCompletions: () => [],
    hasPendingCompletions: () => false,
    markAwaitedCompletion: () => undefined,
  };
  function makeShell(id: number) {
    let completed = false;
    const listeners: Array<(completion: any) => void> = [];
    const shell: any = {
      id,
      pid: id + 100,
      signal: new AbortController().signal,
      stdin: { write: (text: string, callback: any) => { work.push(["write", text]); callback?.(null); }, end: () => work.push(["end"]) },
      abort: () => { shell.aborted = true; },
      dispose: () => { shell.disposed = true; },
      onComplete: (listener: any) => { listeners.push(listener); if (completed) listener(undefined); },
      complete: (completion: any) => { completed = true; listeners.forEach((listener) => listener(completion)); },
    };
    shells.set(id, shell);
    return shell;
  }
  const factory = { spawn: async () => makeShell(nextId++), adopt: async () => makeShell(nextId++) };
  const manager = new BackgroundShellManager(factory as never, registry as never);
  return { manager, work, shells };
}
const spawnInput = { ctx: {}, shellId: 1_000, command: "sleep 1", workingDirectory: "/repo" };

describe("the shells that keep running", () => {
  it("a core shell tells everyone once, and aborting is terminal", () => {
    const controller = new AbortController();
    const shell = new CoreBackgroundShell(7, controller);
    const seen: any[] = [];
    shell.onComplete((completion) => seen.push(completion));
    shell.markCompleted({ code: 0, aborted: false });
    shell.markCompleted({ code: 1, aborted: false });
    shell.dispose();
    shell.dispose();
    assert.deepEqual(seen, [{ code: 0, aborted: false }]);
    assert.equal(shell.isDisposed(), true);
    assert.equal(controller.signal.aborted, true);
    assert.equal(shell.id, 7);
  });

  it("registers, hands out ids and cleans up a spawned shell", async () => {
    const { manager, work, shells } = harness();
    const spawned = await manager.spawn({ ...spawnInput, description: "a sleep" } as never, {} as never);
    assert.deepEqual(work[0], ["upsert", { id: "1000", kind: "shell", state: "running", metadata: { title: "a sleep", cwd: "/repo", startTimeMs: work[0]![1].metadata.startTimeMs }, abort: work[0]![1].abort }]);
    assert.equal(manager.isRunning(spawned.shellId), true);
    const ids = [manager.generateShellId(), manager.generateShellId()];
    assert.equal(ids[1]! - ids[0]!, 1, "ids are handed out in sequence");
    assert.equal(manager.abort(spawned.shellId), true);
    assert.equal(shells.get(spawned.shellId)?.aborted, true);
    assert.equal(manager.isRunning(spawned.shellId), false);
    assert.deepEqual(work.at(-1), ["clear", "1000"]);
    assert.equal(manager.abort(999_999), false);
  });

  it("reports a completion to the work queue", async () => {
    const { manager, work, shells } = harness();
    const spawned = await manager.spawn({ ...spawnInput, description: "a sleep", toolCallId: "call-1", conversationId: "conv-1" } as never, {} as never);
    shells.get(spawned.shellId)!.complete({ code: 3, aborted: false, outputPath: "/terms/1000.txt" });
    const enqueued = work.find((entry) => entry[0] === "enqueue")!;
    assert.deepEqual(enqueued[1], {
      conversationId: "conv-1",
      id: "1000",
      source: "shell",
      payload: { taskId: "1000", toolCallId: "call-1", kind: "shell", status: "error", title: "a sleep", detail: "exit_code=3", outputPath: "/terms/1000.txt", reason: "task_finished" },
    });
    assert.equal(work.at(-1)[0], "clear");
  });

  it("adopts a shell that already runs", async () => {
    const { manager, work } = harness();
    const adopted = await manager.adopt({ ctx: {}, shellId: 2_000, command: "tail -f x", workingDirectory: "/repo", initialOutput: "", abortController: new AbortController(), eventIterator: {} as never, startTime: 42, showElapsedTime: false, description: "a tail" } as never);
    assert.equal(adopted.shellId, 1_000);
    assert.equal(work[0][1].metadata.title, "a tail");
    assert.equal(work[0][1].metadata.startTimeMs, "42", "the metadata is encoded for the work record");
  });

  it("writes stdin, ending at an eot in either spelling", async () => {
    const plain = harness();
    const spawned = await plain.manager.spawn(spawnInput as never, {} as never);
    await plain.manager.writeStdin(spawned.shellId, "hello\n");
    assert.deepEqual(plain.work.filter((entry) => entry[0] === "write"), [["write", "hello\n"]]);
    const eot = harness();
    const second = await eot.manager.spawn(spawnInput as never, {} as never);
    await eot.manager.writeStdin(second.shellId, "before\x04after");
    assert.deepEqual(eot.work.filter((entry) => entry[0] === "write" || entry[0] === "end"), [["write", "before"], ["end"]]);
    const escaped = harness();
    const third = await escaped.manager.spawn(spawnInput as never, {} as never);
    await escaped.manager.writeStdin(third.shellId, "before\\u0004after");
    assert.deepEqual(escaped.work.filter((entry) => entry[0] === "write" || entry[0] === "end"), [["write", "before"], ["end"]]);
    await assert.rejects(plain.manager.writeStdin(999_999, "x"), { message: "Shell not found" });
  });

  it("skips an id that a running shell already has", async () => {
    const shell = { id: 5_000, pid: 1, signal: new AbortController().signal, stdin: undefined, abort: () => undefined, dispose: () => undefined, onComplete: () => undefined };
    const manager = new BackgroundShellManager({ spawn: async () => shell, adopt: async () => shell } as never);
    await manager.spawn(spawnInput as never, {} as never);
    (manager as any).nextId = 5_000;
    assert.equal(manager.generateShellId(), 5_001, "an id in use is not handed out");
  });

  it("disposes every running shell", async () => {
    const { manager, work, shells } = harness();
    const spawned = await manager.spawn(spawnInput as never, {} as never);
    manager.dispose();
    assert.equal(shells.get(spawned.shellId)?.disposed, true);
    assert.equal(manager.isRunning(spawned.shellId), false);
    assert.deepEqual(work.at(-1), ["clear", "1000"]);
  });

  it("passes the owner conversation through the override wrapper", () => {
    const seen: any[] = [];
    const inner = {
      enqueue: (notice: any) => seen.push(["enqueue", notice]),
      pull: (id: string) => ["pulled", id],
      ack: (ids: readonly string[]) => ["acked", ...ids],
      nack: (ids: readonly string[], opts: unknown) => seen.push(["nack", ids, opts]),
      suppress: (conversationId: string, id: string) => seen.push(["suppress", conversationId, id]),
      upsertWork: (record: any) => seen.push(["upsert", record]),
      clearWork: (id: string) => ["cleared", id],
      abortWork: (id: string) => id === "yes",
      hasRunningWork: () => true,
      abortAllWork: () => 3,
      listWork: () => ["work"],
      drainCompletions: () => ["drained"],
      hasPendingCompletions: () => false,
      markAwaitedCompletion: (taskId: string) => seen.push(["awaited", taskId]),
    };
    const wrapper = new ConversationOwnerOverrideRegistry(inner as never, "owner");
    wrapper.enqueue({ id: "wake-1" });
    wrapper.enqueueCompletion({ taskId: "task-1", kind: "shell", exitCode: 0 });
    wrapper.markAwaitedCompletion("task-9");
    assert.deepEqual(seen, [
      ["enqueue", { id: "wake-1", conversationId: "owner" }],
      ["enqueue", { conversationId: "owner", id: "task-1", source: "shell", payload: { taskId: "task-1", kind: "shell", exitCode: 0 } }],
      ["suppress", "owner", "task-9"],
    ]);
    assert.deepEqual([wrapper.pull("c"), wrapper.ack(["t"]), wrapper.clearWork("t"), wrapper.abortWork("yes"), wrapper.hasRunningWork(), wrapper.abortAllWork(), wrapper.listWork(), wrapper.drainCompletions(), wrapper.hasPendingCompletions("c")], [["pulled", "c"], ["acked", "t"], ["cleared", "t"], true, true, 3, ["work"], ["drained"], false]);
  });
});