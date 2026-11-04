import assert from "node:assert/strict";
import { test } from "node:test";

import { createContext } from "../../source/packages/context/context.ts";
import type { ProductionTurnAgentOwner } from "../../source/host/runner/production-turn-agent-owner.ts";
import {
  createProductionTurnRunShellAdapter,
  type ProductionTurnRunShellAdapterInput,
} from "../../source/host/runner/production-turn-run-shell-adapter.ts";

test("preparation failure releases the owner and its linked run context", async () => {
  const events: string[] = [];
  const owner = {
    dispose: () => events.push("owner-disposed"),
  } as unknown as ProductionTurnAgentOwner;
  const input = {
    createOwner: async () => owner,
    createRunInput: async () => { throw new Error("projection failed"); },
    promptOptions: () => ({}),
    createSession: () => ({ getModelId: () => "model", getExecutor: () => ({}) }),
    context: () => createContext(),
    createSettleHost: () => ({}),
    profilePromptSnapshots: () => ({}),
    isSubagentRunner: false,
    subagents: { sessions: new Map() },
    getConversationId: () => "agent-1",
    runGeneration: () => 1,
    setActiveTurnRequestSource: () => {},
    beginAutoReviewUserMessageEpoch: () => {},
    setActiveRunInterrupted: () => {},
    setAwaitingUserSelection: () => {},
    isAwaitingUserSelection: () => false,
    emitRunLifecycle: () => {},
    emitUpdate: () => {},
    cancelThisRun: () => {},
    onRunUnwind: () => events.push("run-unwound"),
  } as unknown as ProductionTurnRunShellAdapterInput;

  await assert.rejects(
    createProductionTurnRunShellAdapter(input).run("start a turn"),
    /projection failed/,
  );
  assert.deepEqual(events, ["owner-disposed", "run-unwound"]);
});
