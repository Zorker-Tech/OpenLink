import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LEDGER_ONLY_DETAIL,
  markerLabel,
  mergeAsyncTasks,
  pendingWakeMarkerToAsyncTask,
  type AsyncTask,
  type PendingWakeMarker,
} from "../../source/host/transcript/async-task-union.ts";

const marker = (fields: Partial<PendingWakeMarker> = {}): PendingWakeMarker => ({ agentId: "a1", kind: "shell", workId: "w1", markedAtMs: 10, ...fields });
const task = (fields: Partial<AsyncTask> = {}): AsyncTask => ({ kind: "shell", id: "w1", label: "a task", status: "running", startedAtMs: 5, ...fields });

describe("what a task the ledger knows is called", () => {
  it("is the title it brought, when it brought one", () => {
    assert.equal(markerLabel(marker({ title: "Deploy" })), "Deploy");
    assert.equal(markerLabel(marker({ title: "" })), "Background command w1", "an empty title is no title");
  });

  it("is named after the kind of work it is", () => {
    assert.equal(markerLabel(marker({ kind: "shell" })), "Background command w1");
    assert.equal(markerLabel(marker({ kind: "cloud-agent" })), "Cloud agent w1");
    assert.equal(markerLabel(marker({ kind: "subagent" })), "Background task w1");
  });
});

describe("a marker read as the task a transcript shows", () => {
  it("is running, started when it was marked, and says only the ledger knows it", () => {
    assert.deepEqual(pendingWakeMarkerToAsyncTask(marker({ workId: "w9", markedAtMs: 42 })), {
      kind: "shell",
      id: "w9",
      label: "Background command w9",
      status: "running",
      startedAtMs: 42,
      detail: LEDGER_ONLY_DETAIL,
    });
    assert.equal(LEDGER_ONLY_DETAIL, "from the durable pending-wake ledger");
  });

  it("names the kind of subagent when it says one", () => {
    assert.equal(pendingWakeMarkerToAsyncTask(marker({ subagentType: "reviewer" })).detail, `reviewer · ${LEDGER_ONLY_DETAIL}`);
    assert.equal(pendingWakeMarkerToAsyncTask(marker({ subagentType: "" })).detail, LEDGER_ONLY_DETAIL);
  });
});

describe("the tasks a transcript shows", () => {
  it("are the live ones, with the ones only the ledger knows added", () => {
    const merged = mergeAsyncTasks([task({ id: "live" })], [marker({ workId: "only" })]);
    assert.deepEqual(merged.map((entry) => entry.id).sort(), ["live", "only"]);
  });

  it("hold a task once, whichever side knows it", () => {
    assert.equal(mergeAsyncTasks([task()], [marker()]).length, 1);
    assert.equal(mergeAsyncTasks([], [marker(), marker({ workId: "w2" })]).length, 2);
    assert.equal(mergeAsyncTasks([], [marker(), marker()]).length, 1, "the same marker twice is the same task twice");
  });

  it("tell two tasks apart by their kind as well as their id", () => {
    assert.equal(mergeAsyncTasks([task({ kind: "shell", id: "same" })], [marker({ kind: "subagent", workId: "same" })]).length, 2);
  });

  it("are ordered by when they started, and then by id", () => {
    const merged = mergeAsyncTasks([task({ id: "late", startedAtMs: 30 }), task({ id: "b", startedAtMs: 10 }), task({ id: "a", startedAtMs: 10 })], []);
    assert.deepEqual(merged.map((entry) => entry.id), ["a", "b", "late"]);
    // The moment comes first: a task whose id sorts earlier but started later is not moved ahead of it.
    const byStart = mergeAsyncTasks([task({ id: "a", startedAtMs: 30 }), task({ id: "b", startedAtMs: 10 })], []);
    assert.deepEqual(byStart.map((entry) => entry.id), ["b", "a"]);
  });

  it("are nothing when neither side knows anything", () => {
    assert.deepEqual(mergeAsyncTasks([], []), []);
  });
});
