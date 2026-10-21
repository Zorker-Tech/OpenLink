import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HostReplicaWriter } from "../../source/host/transcript/replica-writer.ts";

/** An epoch in the shape a writer is told one, which is a uuid. */
const EPOCH = "123e4567-e89b-42d3-a456-426614174000";

describe("the order a surface is replicated in", () => {
  it("counts each surface on its own, from the epoch it was made with", () => {
    const writer = new HostReplicaWriter(EPOCH);
    assert.equal(writer.processEpoch, EPOCH);
    assert.deepEqual(writer.nextStamp("members"), { replicaKey: "members", epoch: EPOCH, sequence: 1 });
    assert.deepEqual(writer.nextStamp("members"), { replicaKey: "members", epoch: EPOCH, sequence: 2 });
    assert.deepEqual(writer.nextStamp("rooms"), { replicaKey: "rooms", epoch: EPOCH, sequence: 1 });
    assert.equal(writer.sequenceOf("members"), 2);
    assert.equal(writer.sequenceOf("rooms"), 1);
  });

  it("answers nothing for a surface it has never stamped", () => {
    assert.equal(new HostReplicaWriter(EPOCH).sequenceOf("never"), 0);
  });

  it("takes a snapshot of where a surface is without moving it", () => {
    const writer = new HostReplicaWriter(EPOCH);
    writer.nextStamp("members");
    const view = writer.viewOf("members", "full", { cases: 1 });
    assert.deepEqual(view, { replicaKey: "members", epoch: EPOCH, throughSequence: 1, coverage: "full", value: { cases: 1 } });
    assert.equal(writer.sequenceOf("members"), 1, "a view describes a position, it does not take one");
    assert.deepEqual(writer.viewOf("never", "none", null), { replicaKey: "never", epoch: EPOCH, throughSequence: 0, coverage: "none", value: null });
  });

  it("gives each writer its own epoch when it was not told one", () => {
    assert.notEqual(new HostReplicaWriter().processEpoch, new HostReplicaWriter().processEpoch);
  });
});
