import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BackgroundShellActionHandler,
  NoOpSideChannelActionHandler,
} from "../../source/packages/agent/actions/background-shell-action-handler.ts";

/** The state handler a turn would hand the action handler. */
const stateHandler = { computeNewStructure: async (ctx: unknown) => ({ computed: ctx }) };

describe("an action handled beside the conversation", () => {
  it("answers with the state the handler computed, and never with a tool call", async () => {
    const handler = new BackgroundShellActionHandler();
    assert.deepEqual(await handler.handle({ a: 1 }, null, null, stateHandler, null, null), { computed: { a: 1 } });
    assert.deepEqual(await handler.handleSingleStep({ b: 2 }, null, null, stateHandler, null, null), { state: { computed: { b: 2 } }, hasToolCall: false });
  });

  it("takes a state handler that answers at once as readily as one that answers later", async () => {
    const handler = new NoOpSideChannelActionHandler();
    const atOnce = { computeNewStructure: (ctx: unknown) => ({ sync: ctx }) };
    assert.deepEqual(await handler.handle({ c: 3 }, null, null, atOnce, null, null), { sync: { c: 3 } });
    assert.deepEqual(await handler.handleSingleStep({ d: 4 }, null, null, atOnce, null, null), { state: { sync: { d: 4 } }, hasToolCall: false });
  });

  it("is the same handler a background shell uses", () => {
    assert.equal(new BackgroundShellActionHandler() instanceof NoOpSideChannelActionHandler, true);
  });
});
