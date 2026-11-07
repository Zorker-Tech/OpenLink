import { test } from "node:test";
import assert from "node:assert/strict";

import { createContext } from "../../source/packages/context/context.ts";
import {
  captureComputerUseScreenshot,
  computerUseExecutorResource,
} from "../../source/adapters/interop/agent/computer-use-executor-adapter.ts";

test("a screenshot request is sent through the registered remote executor", async () => {
  const context = createContext();
  const calls: unknown[] = [];
  const box = {
    async ensureReady(receivedContext: unknown, agentId: string) {
      assert.equal(receivedContext, context);
      assert.equal(agentId, "agent-7");
      return {
        remoteAccessor: {
          get(resource: unknown) {
            assert.equal(resource, computerUseExecutorResource);
            return {
              async execute(_ctx: unknown, args: { actions: Array<{ kind: string }> }) {
                calls.push(args);
                return { kind: "success", actionCount: 1, durationMs: 0, screenshot: "data:image/png;base64,AA==" };
              },
            };
          },
        },
      };
    },
  };

  assert.equal(
    await captureComputerUseScreenshot(box, context, "agent-7"),
    "data:image/png;base64,AA==",
  );
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as { actions: Array<{ kind: string }> }).actions[0]?.kind, "screenshot");
});

test("a missing remote accessor or unsuccessful response yields no image", async () => {
  const context = createContext();
  assert.equal(
    await captureComputerUseScreenshot({ async ensureReady() { return {}; } }, context, "agent-1"),
    null,
  );
  assert.equal(
    await captureComputerUseScreenshot({
      async ensureReady() {
        return {
          remoteAccessor: {
            get() {
              return { async execute() { return { kind: "unknown" }; } };
            },
          },
        };
      },
    }, context, "agent-1"),
    null,
  );
});
