import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as wakeupModule from "../../source/packages/agent-exec/wakeup/index.ts";
import { mergeWakeup, type Wakeup } from "../../source/packages/agent-exec/wakeup/index.ts";

const wakeup = (conversationId: string, id: string, groupKey?: string, extra: Record<string, unknown> = {}): Wakeup =>
  ({ conversationId, id, ...(groupKey === undefined ? {} : { groupKey }), ...extra });

describe("merging a wakeup into a queue", () => {
  it("treats the same work in the same conversation as the same wakeup", () => {
    const queue = [wakeup("c1", "t1")];
    const merged = mergeWakeup(queue, wakeup("c1", "t1"));
    assert.deepEqual(merged.queue, queue);
    assert.equal(merged.replaced, undefined);
    // The queue is replaced rather than changed, since the caller may still be holding the one it passed.
    assert.notEqual(merged.queue, queue);
    assert.deepEqual(Object.keys(wakeupModule).sort(), ["mergeWakeup"], "the rest of the file is a type");
  });

  it("keeps the same work in another conversation, and other work in the same conversation", () => {
    assert.equal(mergeWakeup([wakeup("c1", "t1")], wakeup("c2", "t1")).queue.length, 2);
    assert.equal(mergeWakeup([wakeup("c1", "t1")], wakeup("c1", "t2")).queue.length, 2);
  });

  it("appends a wakeup with no group, even when the queue already holds one", () => {
    const merged = mergeWakeup([wakeup("c1", "t1")], wakeup("c1", "t2"));
    assert.deepEqual(merged.queue.map((entry) => entry.id), ["t1", "t2"]);
  });

  it("replaces the wakeup waiting for its group, and hands the replaced one back", () => {
    const waiting = wakeup("c1", "t1", "progress");
    const other = wakeup("c1", "t2");
    const merged = mergeWakeup([waiting, other], wakeup("c1", "t3", "progress"));
    assert.deepEqual(merged.queue.map((entry) => entry.id), ["t3", "t2"]);
    assert.equal(merged.replaced, waiting);
    assert.equal(merged.queue[1], other, "the other entries are the queue's own");
  });

  it("replaces the first waiter when two wait on the same group, and appends a group nobody waits for", () => {
    const merged = mergeWakeup([wakeup("c1", "t1", "g"), wakeup("c1", "t2", "g")], wakeup("c1", "t3", "g"));
    assert.deepEqual(merged.queue.map((entry) => entry.id), ["t3", "t2"]);
    assert.equal(mergeWakeup([wakeup("c1", "t1")], wakeup("c1", "t2", "g")).queue.length, 2);
    assert.equal(mergeWakeup([wakeup("c1", "t1", "")], wakeup("c1", "t2", "")).queue.length, 1, "an empty-string group is a group");
  });

  it("does not replace across conversations", () => {
    const merged = mergeWakeup([wakeup("c1", "t1", "progress")], wakeup("c2", "t2", "progress"));
    assert.equal(merged.queue.length, 2);
    assert.equal(merged.replaced, undefined);
  });

  it("keeps its own copy of the wakeup it was given", () => {
    const incoming = wakeup("c1", "t1", "g", { payload: "first", nested: { value: "first" } });
    const merged = mergeWakeup([], incoming);
    incoming.payload = "changed";
    (incoming.nested as { value: string }).value = "changed";
    assert.equal(merged.queue[0]?.payload, "first");
    assert.deepEqual(merged.queue[0]?.nested, { value: "changed" }, "the copy is shallow: the nested object is shared, as it was");
    // A grouped replacement holds a copy too, not the object it was handed.
    const waiting = wakeup("c1", "t1", "progress", { payload: "waiting" });
    const replacement = wakeup("c1", "t2", "progress", { payload: "replacement" });
    const replaced = mergeWakeup([waiting], replacement);
    replacement.payload = "changed";
    assert.equal(replaced.queue[0]?.payload, "replacement");
  });

  it("accepts frozen queues and frozen wakeups", () => {
    const queue = Object.freeze([Object.freeze(wakeup("c1", "t1", "g")), Object.freeze(wakeup("c1", "t2"))]);
    const merged = mergeWakeup(queue, Object.freeze(wakeup("c1", "t3", "g")));
    assert.deepEqual(merged.queue.map((entry) => entry.id), ["t3", "t2"]);
  });
});