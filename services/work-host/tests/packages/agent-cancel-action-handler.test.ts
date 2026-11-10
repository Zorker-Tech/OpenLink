import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CancelActionHandler } from "../../source/packages/agent/actions/cancel-action-handler.ts";
import { createSlateCancelActionPayload } from "../../source/packages/agent/actions/cancel-action-contracts.ts";

const collaborators = () => ({
  config: { model: "m" },
  resourceAccessor: { get: () => undefined },
  interactionListener: { onEvent: () => undefined },
  summarizationHandler: { summarize: () => undefined },
  conversationActionReceiver: { receive: () => undefined },
});

const collaboratorsTuple = () => {
  const given = collaborators();
  return [given.config, given.resourceAccessor, given.interactionListener, given.summarizationHandler, given.conversationActionReceiver] as const;
};

const turnArguments = (extra?: unknown) => [undefined, createSlateCancelActionPayload("stop"), undefined, undefined, extra, undefined] as const;

describe("the cancellation action's handler", () => {
  it("refuses the call with the message the agent expects", async () => {
    const handler = new CancelActionHandler(...collaboratorsTuple());
    await assert.rejects(handler.handle(...turnArguments()), {
      name: "Error",
      message: "Cancel Conversation action should never be routed directly to runStream!",
    });
  });

  it("answers a rejected promise rather than throwing at the caller", async () => {
    const handler = new CancelActionHandler(...collaboratorsTuple());
    const answered = handler.handle(...turnArguments());
    assert.equal(answered instanceof Promise, true);
    await assert.rejects(answered, { message: "Cancel Conversation action should never be routed directly to runStream!" });
  });

  it("answers a fresh error for every call", async () => {
    const handler = new CancelActionHandler(...collaboratorsTuple());
    const first = await handler.handle(...turnArguments()).catch((error: Error) => error);
    const second = await handler.handle(...turnArguments()).catch((error: Error) => error);
    assert.notEqual(first, second);
    assert.equal(first.message, second.message);
  });

  it("keeps the five collaborators it was constructed with, in order", () => {
    const given = collaborators();
    const handler = new CancelActionHandler(given.config, given.resourceAccessor, given.interactionListener, given.summarizationHandler, given.conversationActionReceiver);
    assert.deepEqual(Object.keys(handler), ["config", "resourceAccessor", "interactionListener", "summarizationHandler", "conversationActionReceiver"]);
    assert.equal(handler.config, given.config);
    assert.equal(handler.resourceAccessor, given.resourceAccessor);
    assert.equal(handler.interactionListener, given.interactionListener);
    assert.equal(handler.summarizationHandler, given.summarizationHandler);
    assert.equal(handler.conversationActionReceiver, given.conversationActionReceiver);
  });

  it("accepts the turn's arguments and reads none of them", async () => {
    const handler = new CancelActionHandler(...collaboratorsTuple());
    const unreadable = { get explode() { throw new Error("an ignored argument was read"); } };
    await assert.rejects(
      handler.handle(unreadable, unreadable as never, unreadable, unreadable, unreadable, unreadable),
      { message: "Cancel Conversation action should never be routed directly to runStream!" },
    );
  });

  it("has the turn runner's arity", () => {
    const handler = new CancelActionHandler(...collaboratorsTuple());
    assert.equal(handler.handle.length, 6);
  });
});
