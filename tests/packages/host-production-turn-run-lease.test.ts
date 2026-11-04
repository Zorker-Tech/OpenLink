import assert from "node:assert/strict";
import { test } from "node:test";

import { ProductionTurnRunLease } from "../../source/host/runner/production-turn-run-lease.ts";

test("only the active prepared turn receives update callbacks", () => {
  const leases = new ProductionTurnRunLease<object, object>();
  const first = {};
  const second = {};
  const firstCallbacks = { collectText: () => {}, collectSendMessage: () => {}, collectReaction: () => {}, collectAgentMessage: () => {}, persistCheckpoint: async () => {}, pauseForUser: () => {}, noteDispatched: () => {} };
  const secondCallbacks = { ...firstCallbacks };

  leases.attach(first, {}, () => {});
  assert.equal(leases.acceptCallbacks(first, firstCallbacks), true);
  assert.equal(leases.activeCallbacksFor(first), firstCallbacks);
  leases.attach(second, {}, () => {});
  assert.equal(leases.activeCallbacksFor(first), undefined, "a superseded turn can no longer report into its successor");
  assert.equal(leases.activeCallbacksFor(second), undefined, "the successor has not started streaming yet");
  assert.equal(leases.acceptCallbacks(second, secondCallbacks), true);
  assert.equal(leases.activeCallbacksFor(second), secondCallbacks);
  assert.equal(leases.forPrepared(first)?.callbacks, firstCallbacks);
  assert.equal(leases.forPrepared({}), undefined);
  assert.equal(leases.releaseActive()?.prepared, second);
  assert.equal(leases.activeCallbacksFor(second), undefined);
});
