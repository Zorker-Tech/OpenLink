import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AbstractUserMessageActionHandler } from "../../source/packages/agent/actions/user-message-action/abstract-user-message-action-handler.ts";

function handler(config: Record<string, unknown> = {}) {
  return new (AbstractUserMessageActionHandler as unknown as new (...args: unknown[]) => AbstractUserMessageActionHandler)(
    config,
    { get: () => undefined },
    {},
    {},
    {},
    {},
  );
}

describe("the abstract user-message action handler", () => {
  it("resolves the write-barrier timeout from the config or its flags", () => {
    assert.equal(handler({ resolveWriteBarrierTimeoutMs: () => 12 }).resolveWriteBarrierTimeoutMs(), 12);
    assert.equal(handler({ featureFlags: { writeBarrierTimeoutMs: 7 } }).resolveWriteBarrierTimeoutMs(), 7);
    assert.equal(handler({ featureFlags: { writeBarrierTimeoutMs: 7 }, resolveWriteBarrierTimeoutMs: () => undefined }).resolveWriteBarrierTimeoutMs(), 7);
    assert.equal(handler({}).resolveWriteBarrierTimeoutMs(), undefined);
  });

  it("does not extract an automation trigger without automation instructions", () => {
    const instance = handler({});
    assert.equal(instance.getAutomationTriggerContext([] as never), undefined);
  });

  it("skips the permission files when smart mode is off", async () => {
    const instance = handler({});
    assert.equal(await instance.getUserPermissionsFileAutoRunInstructions({} as never, {} as never), undefined);
  });

  it("passes the stream through when response comparison is not set up", async () => {
    const instance = handler({});
    const parts = [{ type: "text-delta", delta: "hi" }, { type: "done" }];
    const stream = (async function* () { for (const part of parts) yield part; })();
    const passed = instance.tapAgentResponseComparisonWarmup({} as never, stream as never, undefined, undefined);
    const received = [];
    for await (const part of passed) received.push(part);
    assert.deepEqual(received, parts);
  });
});
