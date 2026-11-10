import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as snapshots from "../../source/packages/agent/tools/core/shell/interrupted-shell-output.ts";
import {
  appendInterruptedShellOutputSnapshot,
  clearInterruptedShellOutputSnapshot,
  getInterruptedShellOutputSnapshot,
  startInterruptedShellOutputSnapshot,
} from "../../source/packages/agent/tools/core/shell/interrupted-shell-output.ts";

const SNAPSHOT_LIMIT = 20_000;
const SNAPSHOT_COUNT = 100;
const read = (toolCallId: string): string | undefined => getInterruptedShellOutputSnapshot(toolCallId);
const drop = (toolCallId: string): void => clearInterruptedShellOutputSnapshot(toolCallId);

describe("an interrupted command's output", () => {
  it("is kept by call, appended to in order, and dropped when the call ends", () => {
    startInterruptedShellOutputSnapshot("basic");
    assert.equal(read("basic"), "", "a started call has an empty buffer, not no buffer");
    appendInterruptedShellOutputSnapshot("basic", "first ");
    appendInterruptedShellOutputSnapshot("basic", "second");
    assert.equal(read("basic"), "first second");
    drop("basic");
    assert.equal(read("basic"), undefined);
    assert.equal(read("never-started"), undefined);
  });

  it("starts a buffer for output that arrives without a start, while an empty append changes nothing", () => {
    appendInterruptedShellOutputSnapshot("no-start", "output");
    assert.equal(read("no-start"), "output");
    drop("no-start");

    appendInterruptedShellOutputSnapshot("empty-absent", "");
    assert.equal(read("empty-absent"), undefined, "an empty append does not create a buffer");

    startInterruptedShellOutputSnapshot("empty-started");
    appendInterruptedShellOutputSnapshot("empty-started", "");
    assert.equal(read("empty-started"), "");
    drop("empty-started");
  });

  it("keeps the end of the output, up to 20,000 characters", () => {
    const long = "x".repeat(SNAPSHOT_LIMIT + 5_000);
    startInterruptedShellOutputSnapshot("long");
    appendInterruptedShellOutputSnapshot("long", long);
    assert.equal(read("long")?.length, SNAPSHOT_LIMIT);
    assert.equal(read("long"), long.slice(-SNAPSHOT_LIMIT), "the beginning is what is lost");
    drop("long");

    const exact = "y".repeat(SNAPSHOT_LIMIT);
    appendInterruptedShellOutputSnapshot("exact", exact);
    assert.equal(read("exact"), exact, "a body of exactly the limit is kept whole");
    appendInterruptedShellOutputSnapshot("exact", "z");
    assert.equal(read("exact"), (exact + "z").slice(-SNAPSHOT_LIMIT));
    drop("exact");

    // The window counts UTF-16 code units, so a long text loses what is at the front of it, surrogate pair or not.
    const emoji = "\u{1f600}".repeat(15_000);
    appendInterruptedShellOutputSnapshot("emoji", emoji);
    assert.equal(read("emoji")?.length, SNAPSHOT_LIMIT);
    assert.equal(read("emoji"), emoji.slice(-SNAPSHOT_LIMIT));
    drop("emoji");
  });

  it("keeps at most 100 calls, dropping the oldest first and never dropping a call it already keeps", () => {
    for (let index = 0; index < SNAPSHOT_COUNT; index += 1) startInterruptedShellOutputSnapshot(`cap-${index}`);
    assert.equal(read("cap-0"), "", "the cap is not reached yet");
    appendInterruptedShellOutputSnapshot("cap-100", "newest");
    assert.equal(read("cap-0"), undefined, "the oldest call makes room for the new one");
    assert.equal(read("cap-1"), "");
    assert.equal(read("cap-100"), "newest");

    // Starting or appending to a call that is already kept never drops anyone: it is already counted.
    startInterruptedShellOutputSnapshot("cap-99");
    assert.equal(read("cap-1"), "", "restarting a kept call does not make room by dropping the oldest");
    appendInterruptedShellOutputSnapshot("cap-98", "more");
    assert.equal(read("cap-1"), "", "appending to a kept call does not make room either");
    assert.equal(read("cap-98"), "more");

    // The next new call drops the next oldest one.
    appendInterruptedShellOutputSnapshot("cap-101", "newer");
    assert.equal(read("cap-1"), undefined);
    assert.equal(read("cap-2"), "");
    for (let index = 0; index <= 101; index += 1) drop(`cap-${index}`);
  });

  it("treats a call seen again after it was cleared as the newest", () => {
    startInterruptedShellOutputSnapshot("again");
    appendInterruptedShellOutputSnapshot("again", "first");
    drop("again");
    appendInterruptedShellOutputSnapshot("again", "second");
    assert.equal(read("again"), "second", "a cleared call does not remember its old output");
    drop("again");
  });

  it("holds prototype-looking call ids like any other, and exposes only its four calls", () => {
    assert.deepEqual(Object.keys(snapshots).sort(), [
      "appendInterruptedShellOutputSnapshot",
      "clearInterruptedShellOutputSnapshot",
      "getInterruptedShellOutputSnapshot",
      "startInterruptedShellOutputSnapshot",
    ]);
    for (const id of ["__proto__", "constructor", "toString"]) {
      appendInterruptedShellOutputSnapshot(id, id);
      assert.equal(read(id), id);
      drop(id);
      assert.equal(read(id), undefined);
    }
  });
});