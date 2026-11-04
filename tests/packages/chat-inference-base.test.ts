import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BaseMiddleware,
  BasePromptBuilder,
  BasePromptExecutor,
  type PromptExecutor,
  type PromptMessage,
} from "../../source/packages/chat-inference/base.ts";
import {
  createPassThroughMiddleware,
  PassThroughMiddleware,
  passThroughMiddleware,
} from "../../source/packages/chat-inference/middleware/noop-middleware.ts";

interface TextMessage { text: string }

const recordedExecutor = () => {
  const calls: unknown[] = [];
  const executor: PromptExecutor<TextMessage> = {
    appendMessages: (messages) => { calls.push(["append", messages]); },
    getState: () => { calls.push(["getState"]); return "the state"; },
    getMessages: () => { calls.push(["getMessages"]); return [{ text: "inner" }]; },
    clearMessages: () => { calls.push(["clear"]); },
    stream: (...args) => { calls.push(["stream", args]); return { streamed: args }; },
  };
  return { calls, executor };
};

describe("a prompt builder", () => {
  it("starts from nothing, one message, or a list, and keeps a copy of the list it was given", () => {
    assert.deepEqual(new BasePromptBuilder<TextMessage>().getState(), []);
    assert.deepEqual(new BasePromptBuilder<TextMessage>({ text: "a" }).getState(), [{ text: "a" }]);
    const given = [{ text: "a" }, { text: "b" }];
    const builder = new BasePromptBuilder<TextMessage>(given);
    given.push({ text: "later" });
    assert.deepEqual(builder.getState(), [{ text: "a" }, { text: "b" }], "the builder owns its messages");
    assert.deepEqual(new BasePromptBuilder<TextMessage>(null as never).getState(), [null], "only undefined means no initial messages");
  });

  it("appends one message or a list, in order, and answers itself so appends chain", () => {
    const builder = new BasePromptBuilder<TextMessage>();
    assert.equal(builder.appendMessages({ text: "one" }), builder);
    builder.appendMessages([{ text: "two" }, { text: "three" }]).appendMessages([]);
    assert.deepEqual(builder.getMessages(), [{ text: "one" }, { text: "two" }, { text: "three" }]);
    builder.clearMessages();
    assert.deepEqual(builder.getMessages(), []);
    assert.equal(builder.appendMessages({ text: "after" }), builder);
    assert.deepEqual(builder.getState(), [{ text: "after" }]);
  });

  it("answers its state as a copy, so a caller cannot change it from outside", () => {
    const builder = new BasePromptBuilder<TextMessage>([{ text: "seed" }]);
    const state = builder.getState();
    const messages = builder.getMessages();
    state.push({ text: "mutated" });
    messages.push({ text: "mutated" });
    assert.deepEqual(builder.getState(), [{ text: "seed" }]);
    assert.notEqual(state, builder.getState());
    assert.notEqual(messages, builder.getMessages());
  });

  it("is a base a subclass can read its messages from", () => {
    class CountingBuilder extends BasePromptBuilder<TextMessage> {
      messageCount(): number { return this.messages.length; }
    }
    const builder = new CountingBuilder([{ text: "a" }]);
    builder.appendMessages({ text: "b" });
    assert.equal(builder.messageCount(), 2);
  });
});

describe("a prompt executor", () => {
  it("forwards the four message calls to its builder and answers itself on append", () => {
    const backing = new BasePromptBuilder<TextMessage>([{ text: "seed" }]);
    const executor = new BasePromptExecutor<TextMessage>(backing);
    assert.equal(executor.appendMessages({ text: "next" }), executor);
    executor.appendMessages([{ text: "more" }]);
    assert.deepEqual(executor.getMessages(), [{ text: "seed" }, { text: "next" }, { text: "more" }]);
    assert.deepEqual(backing.getMessages(), executor.getMessages(), "the builder is what actually holds the messages");
    executor.clearMessages();
    assert.deepEqual(backing.getMessages(), []);
    assert.deepEqual(executor.getState(), []);
  });

  it("is a base a subclass can read its builder from", () => {
    class PeekingExecutor extends BasePromptExecutor<TextMessage> {
      builderMessages(): TextMessage[] { return this.builder.getMessages(); }
    }
    const executor = new PeekingExecutor(new BasePromptBuilder([{ text: "c" }]));
    assert.deepEqual(executor.builderMessages(), [{ text: "c" }]);
  });
});

describe("a prompt middleware", () => {
  it("forwards every call to the executor it wraps, and streams with the caller's arguments", () => {
    const { calls, executor } = recordedExecutor();
    const middleware = new BaseMiddleware<TextMessage>(executor);
    assert.equal(middleware.appendMessages({ text: "m" }), middleware);
    middleware.appendMessages([{ text: "m2" }]);
    assert.equal(middleware.getState(), "the state");
    assert.deepEqual(middleware.getMessages(), [{ text: "inner" }]);
    middleware.clearMessages();
    assert.deepEqual(middleware.stream("a", 2, { b: true }), { streamed: ["a", 2, { b: true }] });
    assert.deepEqual(calls, [
      ["append", { text: "m" }],
      ["append", [{ text: "m2" }]],
      ["getState"],
      ["getMessages"],
      ["clear"],
      ["stream", ["a", 2, { b: true }]],
    ]);
  });

  it("is a base a subclass can read the wrapped executor from, and override the stream", () => {
    const { executor } = recordedExecutor();
    class WrappingMiddleware extends BaseMiddleware<TextMessage> {
      innerMessages(): TextMessage[] { return this.innerExecutor.getMessages(); }
      override stream(): unknown { return { wrapped: this.innerExecutor.stream() }; }
    }
    const middleware = new WrappingMiddleware(executor);
    assert.deepEqual(middleware.innerMessages(), [{ text: "inner" }]);
    assert.deepEqual(middleware.stream(), { wrapped: { streamed: [] } });
  });

  it("is a prompt executor itself, so layers stack", () => {
    const { executor } = recordedExecutor();
    const outer = new BaseMiddleware<TextMessage>(new BaseMiddleware<TextMessage>(executor));
    assert.deepEqual(outer.getMessages(), [{ text: "inner" }]);
    assert.deepEqual((outer as { stream(...args: unknown[]): unknown }).stream("x"), { streamed: ["x"] });
  });
});

describe("a pass-through middleware", () => {
  it("uses the provided executor without changing its behavior", () => {
    const { calls, executor } = recordedExecutor();
    const middleware = passThroughMiddleware(executor);
    assert.equal(middleware instanceof PassThroughMiddleware, true);
    assert.equal(middleware.getState(), "the state");
    assert.deepEqual(middleware.stream("request"), { streamed: ["request"] });

    const makeMiddleware = createPassThroughMiddleware<TextMessage>();
    assert.equal(makeMiddleware(executor) instanceof PassThroughMiddleware, true);
    assert.deepEqual(calls, [["getState"], ["stream", ["request"]]]);
  });
});

describe("the prompt message shape", () => {
  it("is a role and its content", () => {
    const message: PromptMessage = { role: "user", content: "hello" };
    assert.deepEqual(message, { role: "user", content: "hello" });
    const structured: PromptMessage = { role: "assistant", content: [{ type: "text", text: "hi" }] };
    assert.equal(Array.isArray(structured.content), true);
  });
});
