import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BackgroundShellActionHandler,
  NoOpSideChannelActionHandler,
} from "../../source/packages/agent/actions/background-shell-action-handler.ts";

/** The contract the handler reads: the one thing it needs to compute the new structure. */
type StructureComputer<Context, State> = { computeNewStructure(ctx: Context): Promise<State> | State };

/** A state computer that records the contexts it was handed and answers the same way every time. */
function computerOf<Context, State>(answer: () => Promise<State> | State): { handler: StructureComputer<Context, State>; seen: Context[] } {
  const seen: Context[] = [];
  return {
    seen,
    handler: {
      computeNewStructure(ctx: Context) {
        seen.push(ctx);
        return answer();
      },
    },
  };
}

/** The turn's five arguments laid out as a caller sends them: the ignored four around the one it reads. */
function turnArguments<Context, State>(handler: StructureComputer<Context, State>) {
  return [undefined, undefined, handler, undefined, undefined] as const;
}

describe("a side-channel action handler", () => {
  it("answers with the structure computed from the context, and nothing else", async () => {
    const context = { conversationId: "conversation-1" };
    const { handler, seen } = computerOf(() => ({ messages: ["computed"] }));

    const result = await new NoOpSideChannelActionHandler().handle(context, ...turnArguments(handler));

    assert.deepEqual(result, { messages: ["computed"] });
    assert.deepEqual(seen, [context], "the context is passed through as it arrived");
  });

  it("answers as a promise even when the structure is computed synchronously", () => {
    const { handler } = computerOf(() => "state");
    const pending = new NoOpSideChannelActionHandler().handle({}, ...turnArguments(handler));
    assert.equal(pending instanceof Promise, true);
    return pending.then(() => undefined);
  });

  it("waits for a structure that is computed asynchronously", async () => {
    const { handler } = computerOf(() => Promise.resolve({ messages: ["async"] }));
    assert.deepEqual(
      await new NoOpSideChannelActionHandler().handle({}, ...turnArguments(handler)),
      { messages: ["async"] },
    );
    const { handler: thenableHandler } = computerOf(() => ({ then: (resolve: (value: unknown) => void) => resolve("from a thenable") }));
    assert.equal(
      await new NoOpSideChannelActionHandler().handle({}, ...turnArguments(thenableHandler)),
      "from a thenable",
    );
  });

  it("accepts the turn's other arguments and reads none of them", async () => {
    const context = {};
    const { handler } = computerOf(() => "state");
    const unreadable = { get explode() { throw new Error("an ignored argument was read"); } };
    const unreadableRoot = { get rootPromptExecutor() { throw new Error("an ignored argument was read"); } };
    const unreadableTools = { get mcpTools() { throw new Error("an ignored argument was read"); } };
    const unreadableUpdate = { get onStateUpdate() { throw new Error("an ignored argument was read"); } };

    const result = await new NoOpSideChannelActionHandler().handle(context, unreadable, unreadableRoot, handler, unreadableTools, unreadableUpdate);

    assert.equal(result, "state");
  });

  it("rejects when the structure cannot be computed, rather than throwing at the caller", async () => {
    for (const method of ["handle", "handleSingleStep"] as const) {
      const { handler } = computerOf(() => { throw new Error("compute failed"); });
      const promised = new NoOpSideChannelActionHandler()[method]({}, ...turnArguments(handler));
      assert.equal(promised instanceof Promise, true);
      await assert.rejects(promised, { message: "compute failed" });
    }
    const { handler: rejecting } = computerOf(() => Promise.reject(new Error("later failed")));
    await assert.rejects(new NoOpSideChannelActionHandler().handle({}, ...turnArguments(rejecting)), { message: "later failed" });

    const withoutComputer = [undefined, undefined, undefined as never, undefined, undefined] as const;
    await assert.rejects(
      () => new NoOpSideChannelActionHandler().handle({}, ...withoutComputer),
      TypeError,
      "a missing state computer is a rejected promise too",
    );
  });
});

describe("the single-step form", () => {
  it("answers the computed state and that there is no tool call", async () => {
    const context = { conversationId: "conversation-2" };
    const { handler, seen } = computerOf(() => ({ messages: ["step"] }));

    const answer = await new NoOpSideChannelActionHandler().handleSingleStep(context, ...turnArguments(handler));

    assert.deepEqual(answer, { state: { messages: ["step"] }, hasToolCall: false });
    assert.deepEqual(Object.keys(answer), ["state", "hasToolCall"]);
    assert.deepEqual(seen, [context]);
  });

  it("waits for an asynchronous structure before answering", async () => {
    const { handler } = computerOf(() => Promise.resolve("late state"));
    const answer = await new NoOpSideChannelActionHandler().handleSingleStep({}, ...turnArguments(handler));
    assert.deepEqual(answer, { state: "late state", hasToolCall: false });
    assert.equal((answer.state as unknown) instanceof Promise, false, "the answer holds the state, not a promise for it");
  });

  it("computes the structure once per call", async () => {
    const { handler, seen } = computerOf(() => "state");
    await new NoOpSideChannelActionHandler().handle({}, ...turnArguments(handler));
    assert.equal(seen.length, 1);
    await new NoOpSideChannelActionHandler().handleSingleStep({}, ...turnArguments(handler));
    assert.equal(seen.length, 2);
  });
});

describe("the shell handler", () => {
  it("is a no-op side-channel handler, so it behaves exactly like one", async () => {
    const ShellHandlerWithArguments = BackgroundShellActionHandler as unknown as new (...args: unknown[]) => BackgroundShellActionHandler;
    const shell = new ShellHandlerWithArguments(1, "two");
    assert.equal(shell instanceof NoOpSideChannelActionHandler, true);
    const { handler } = computerOf(() => "state");

    assert.equal(await shell.handle({}, ...turnArguments(handler)), "state");
    assert.deepEqual(await shell.handleSingleStep({}, ...turnArguments(handler)), { state: "state", hasToolCall: false });
  });

  it("works when its methods are called without an instance", async () => {
    type DetachedMethod = (this: unknown, ...args: unknown[]) => Promise<unknown>;
    const { handle, handleSingleStep } = new BackgroundShellActionHandler();
    const { handler } = computerOf(() => "state");

    assert.equal(await (handle as unknown as DetachedMethod).call(undefined, {}, ...turnArguments(handler)), "state");
    assert.deepEqual(await (handleSingleStep as unknown as DetachedMethod).call(undefined, {}, ...turnArguments(handler)), {
      state: "state",
      hasToolCall: false,
    });
  });
});