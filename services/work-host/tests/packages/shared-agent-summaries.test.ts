import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compareAgentSummaries, upsertAgentSummary } from "../../source/shared/agents/agent-summaries.ts";

interface Summary {
  readonly id: string;
  readonly updatedAt: number;
}

const summary = (id: string, updatedAt: number): Summary => ({ id, updatedAt });
const idsOf = (summaries: readonly Summary[]): string[] => summaries.map((entry) => entry.id);

describe("agent summaries", () => {
  it("are compared newest first by the time the agent last reported", () => {
    const list = [summary("a", 10), summary("b", 30), summary("c", 20)];
    assert.deepEqual([...list].sort(compareAgentSummaries).map((entry) => entry.id), ["b", "c", "a"]);
    // Agents that reported at the same time keep the order they were already in.
    const sameTime = [summary("a", 5), summary("b", 5)];
    assert.deepEqual([...sameTime].sort(compareAgentSummaries).map((entry) => entry.id), ["a", "b"]);
    // The comparator is the subtraction itself: a newer first argument sorts earlier.
    assert.equal(compareAgentSummaries(summary("a", 1), summary("b", 4)), 3);
    assert.equal(compareAgentSummaries(summary("a", 9), summary("b", 4)), -5);
  });

  it("replace an agent's summary instead of adding a second copy", () => {
    const list = [summary("a", 10), summary("b", 30)];
    const next = upsertAgentSummary(list, summary("a", 40));
    assert.equal(next.length, 2);
    assert.deepEqual(idsOf(next), ["a", "b"]);
    assert.equal(next.find((entry) => entry.id === "a")?.updatedAt, 40);
    // The list handed in is left as it was.
    assert.deepEqual(idsOf(list), ["a", "b"]);
    assert.equal(list[0]?.updatedAt, 10);
  });

  it("place an agent that reports an older time where that time puts it", () => {
    const next = upsertAgentSummary([summary("a", 10), summary("b", 30)], summary("a", 5));
    assert.deepEqual(idsOf(next), ["b", "a"]);
    assert.equal(next.find((entry) => entry.id === "a")?.updatedAt, 5);
  });

  it("add an agent new to the list, in its time's place", () => {
    const list = [summary("a", 10), summary("b", 30)];
    assert.deepEqual(idsOf(upsertAgentSummary(list, summary("c", 20))), ["b", "c", "a"]);
    assert.deepEqual(idsOf(upsertAgentSummary(list, summary("c", 40))), ["c", "b", "a"]);
    assert.deepEqual(idsOf(upsertAgentSummary([], summary("only", 1))), ["only"]);
  });

  it("replace every copy when the list somehow holds one agent twice, and return a new list", () => {
    const list = [summary("a", 1), summary("a", 2), summary("b", 3)];
    const next = upsertAgentSummary(list, summary("a", 5));
    assert.equal(next.length, 3);
    assert.deepEqual(next.filter((entry) => entry.id === "a").map((entry) => entry.updatedAt), [5, 5]);
    assert.notEqual(next, list);
    assert.deepEqual(idsOf(list), ["a", "a", "b"], "the input list is not reordered or shortened");
  });
});
