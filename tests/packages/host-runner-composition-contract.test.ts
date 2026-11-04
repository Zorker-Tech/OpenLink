import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHostRunnerComposition } from "../../source/host/host-runner-composition.ts";

type RunnerOptions = Record<string, unknown>;

function harness() {
  const subscriptions: Array<(event: unknown) => void> = [];
  const unsubscribeCalls: string[] = [];
  const reviewBindings: Array<Record<string, unknown>> = [];
  const runnerOptions: RunnerOptions[] = [];
  const runnerCalls: string[][] = [];
  const apis: Record<string, Record<string, unknown>> = {
    "local-tool-permission": {
      subscribe: (listener: (event: unknown) => void) => {
        subscriptions.push(listener);
        const index = subscriptions.length;
        return () => unsubscribeCalls.push(String(index));
      },
    },
    "auto-review": {
      bindRunner: (binding: Record<string, unknown>) => {
        reviewBindings.push(binding);
        return {};
      },
    },
  };
  const composition = createHostRunnerComposition({
    extensions: { api: (id: string) => apis[id] ?? {} },
    ctx: {},
    emitGatewayEvent: () => {},
    buildRunner: (options: RunnerOptions) => {
      runnerOptions.push(options);
      const calls: string[] = [];
      runnerCalls.push(calls);
      return new Proxy({}, {
        get(_target, name) {
          if (name === "then") return undefined;
          return (..._args: unknown[]) => calls.push(String(name));
        },
      });
    },
    createTranscriptMirror: () => ({ kind: "private-transcript-mirror" }),
  } as never);
  return { composition, subscriptions, unsubscribeCalls, reviewBindings, runnerOptions, runnerCalls };
}

const session = (id = "agent-1") => ({
  id,
  dbPath: `/sessions/${id}/agent.db`,
  agentStore: { kind: "agent-store" },
  memory: { kind: "private-memory" },
  automations: { kind: "automations" },
  workflows: { kind: "workflows" },
  channels: { kind: "channels" },
  db: { kind: "session-db" },
});

const hooks = { transport: { onUpdate: () => {} } };

describe("the host runner composition boundary", () => {
  it("binds a normal conversation's stores and retires its permission prompt when a group turn replaces it", async () => {
    const h = harness();
    const agentSession = session();
    h.composition.createRunner(agentSession, hooks as never);
    assert.equal(h.composition.canAskLocalToolPermission("agent-1"), true);
    assert.equal(h.runnerOptions[0]?.memoryStore, agentSession.memory);
    assert.deepEqual(h.reviewBindings[0]?.approvalsResolvable, true);

    h.composition.createGroupMemberRunner(session(), hooks as never, {});
    assert.equal(h.composition.canAskLocalToolPermission("agent-1"), false);
    assert.deepEqual(h.reviewBindings[1]?.approvalsResolvable, false);
    assert.deepEqual(h.unsubscribeCalls, ["1"], "the replacement retires the earlier prompt subscription");

    await h.composition.dispose();
    assert.deepEqual(h.runnerCalls.map((calls) => calls.slice(-2)), [
      ["interrupt", "dispose"],
      ["interrupt", "dispose"],
    ]);
    assert.equal(h.subscriptions.length, 1, "a group-member turn does not install a prompt surface");
  });

  it("leaves private conversation projections off a shared-room group-member turn", () => {
    const h = harness();
    h.composition.createGroupMemberRunner(session(), hooks as never, { isSharedRoomTurn: true });
    const options = h.runnerOptions[0]!;
    assert.equal(options.isSharedRoomTurn, true);
    for (const key of [
      "transcriptMirror",
      "memoryStore",
      "userMemory",
      "projectMemory",
      "agentState",
      "agentStore",
      "mcp",
      "mcpManagement",
      "automationStore",
      "workflowStore",
      "channelStore",
    ]) {
      assert.equal(Object.hasOwn(options, key), false, `${key} is private conversation state`);
    }
  });
});
