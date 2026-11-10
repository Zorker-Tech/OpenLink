import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createContext } from "../../source/packages/context/context.ts";
import { initBashState } from "../../source/packages/shell-exec/bash.ts";
import type { TerminalEvent } from "../../source/packages/shell-exec/naive.ts";

const ctx = createContext();
const states: Array<Awaited<ReturnType<typeof initBashState>>> = [];
async function freshState() { const state = await initBashState({}); states.push(state); return state; }
after(() => { states.length = 0; });

async function run(state: Awaited<ReturnType<typeof initBashState>>, command: string, settings: Record<string, unknown> = {}): Promise<TerminalEvent[]> {
  const events: TerminalEvent[] = [];
  for await (const event of state.execute(ctx, command, settings as never)) events.push(event);
  return events;
}
const textOf = (events: TerminalEvent[]) => events.flatMap((event) => event.type === "stdout" ? [String((event as { data: unknown }).data)] : []).join("");
const exitOf = (events: TerminalEvent[]) => events.find((event): event is Extract<TerminalEvent, { type: "exit" }> => event.type === "exit");

describe("the bash driver", () => {
  it("starts in the working directory and runs a command", async () => {
    const state = await freshState();
    assert.equal((await state.getCwd()).startsWith("/"), true);
    const events = await run(state, "echo hello");
    assert.equal(textOf(events), "hello\n");
    assert.deepEqual(events.map((event) => event.type), ["stdin_ready", "stdout", "exit"]);
    assert.equal(exitOf(events)?.code, 0);
    assert.equal(exitOf(events)?.aborted, false);
  });

  it("carries variables and functions between commands", async () => {
    const state = await freshState();
    await run(state, "export SLATE_BASH_TEST=41; greet() { echo greeting$SLATE_BASH_TEST; }");
    const events = await run(state, "echo $SLATE_BASH_TEST; greet");
    assert.equal(textOf(events), "41\ngreeting41\n");
  });

  it("reports a failing command without aborting the shell", async () => {
    const state = await freshState();
    const failed = await run(state, "exit 7");
    assert.equal(exitOf(failed)?.code, 7);
    const next = await run(state, "echo still here");
    assert.equal(textOf(next), "still here\n");
    assert.equal(exitOf(next)?.code, 0);
  });

  it("clones with another working directory and keeps the state", async () => {
    const state = await freshState();
    await run(state, "export SLATE_BASH_CLONE=done");
    const cloned = state.clone("/");
    const events = await run(cloned, "pwd; echo $SLATE_BASH_CLONE");
    assert.equal(textOf(events), "/\ndone\n");
  });

  it("feeds a command its stdin when asked", async () => {
    const state = await freshState();
    const events: TerminalEvent[] = [];
    for await (const event of state.execute(ctx, "cat", { pipeStdin: true })) {
      events.push(event);
      if (event.type === "stdin_ready") { event.stdin?.end("from stdin\n"); }
    }
    assert.equal(textOf(events), "from stdin\n");
    assert.equal(exitOf(events)?.code, 0);
  });

  it("runs with the environment it is given", async () => {
    const state = await freshState();
    const events = await run(state, "echo $SLATE_BASH_ENV_TEST", { env: { SLATE_BASH_ENV_TEST: "from-the-test" } });
    assert.equal(textOf(events), "from-the-test\n");
    assert.equal(exitOf(events)?.code, 0);
  });
});
