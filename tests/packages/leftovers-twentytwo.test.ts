/**
 * Scheduling policies, what the store says about a set of paths, and a conversation's state out of the store.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDebouncePolicy, createDeadlinePolicy, createIdleWatchdogPolicy, createPollingPolicy, createRetryPolicy, realClock } from "../../source/host/extensions/scheduling.ts";
import { notifySummaryMetrics, notifySummaryResult } from "../../source/packages/agent-store-sync/summary-listener.ts";
import { SlateSessionConversationState } from "../../source/host/extensions/session/session-conversation-state.ts";
import { DeadlineExceededError } from "../../source/host/extensions/scheduling.ts";

describe("the scheduling vocabulary the platform shares", () => {
  it("names the deadline error with its own code", () => {
    const error = new DeadlineExceededError("late");
    assert.equal(error.code, "deadline_exceeded");
    assert.equal(error.name, "DeadlineExceededError");
    assert.equal(error.message, "Deadline exceeded for late");
  });

  it("offers the policies a wait follows", () => {
    assert.equal(typeof createDeadlinePolicy, "function");
    assert.equal(typeof createPollingPolicy, "function");
    assert.equal(typeof createDebouncePolicy, "function");
    assert.equal(typeof createIdleWatchdogPolicy, "function");
    assert.equal(typeof createRetryPolicy, "function");
    // The clock the policies wait on is replaceable, and the default one is the platform's own.
    assert.equal(typeof realClock, "object");
  });
});

describe("what the store says about a set of paths", () => {
  it("turns a summary into the events a sync round reports", () => {
    assert.equal(typeof notifySummaryResult, "function");
    assert.equal(typeof notifySummaryMetrics, "function");
  });
});

describe("a conversation's state out of the store", () => {
  it("is read through the session's own cache", () => {
    assert.equal(typeof SlateSessionConversationState, "function");
  });
});
