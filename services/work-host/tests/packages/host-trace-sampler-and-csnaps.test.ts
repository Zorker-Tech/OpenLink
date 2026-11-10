import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { csnapsAvailability, csnapsPath } from "../../source/host/extensions/codebase-telemetry/csnaps-capability.ts";
import {
  NeverRecords,
  SampleDecision,
  FollowsItsParent,
  sendTraceSampler,
} from "../../source/host/telemetry/send-trace-sampler.ts";

const roots: string[] = [];
const scratch = (): string => {
  const root = mkdtempSync(join(tmpdir(), "slate-csnaps-"));
  roots.push(root);
  return root;
};
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("whether a send is traced", () => {
  it("is never recorded at the root, and follows whatever trace it arrives under", () => {
    assert.deepEqual(SampleDecision, { NOT_RECORD: 0, RECORD: 1, RECORD_AND_SAMPLED: 2 });
    assert.deepEqual(new NeverRecords().shouldSample(), { decision: SampleDecision.NOT_RECORD });
    assert.equal(new NeverRecords().toString(), "AlwaysOffSampler", "the label a tracer records is the sampler's tracing name");
    const sampler = sendTraceSampler();
    assert.deepEqual(sampler.shouldSample(), { decision: SampleDecision.NOT_RECORD });
    assert.equal(sampler.toString(), "ParentBased{root=AlwaysOffSampler}");
  });

  it("answers what its root answers, whatever that root answers", () => {
    // A root that records is not one this build ships, but the sampler must still follow it rather than decide for
    // itself — which is what makes it parent-based at all.
    const recording = { shouldSample: () => ({ decision: SampleDecision.RECORD }), toString: () => "Root" };
    assert.deepEqual(new FollowsItsParent({ root: recording as never }).shouldSample(), { decision: SampleDecision.RECORD });
    assert.equal(new FollowsItsParent({ root: recording as never }).toString(), "ParentBased{root=Root}");
  });
});

describe("whether the codebase-telemetry helper is there", () => {
  it("takes an override from the environment, and otherwise lives beside the bundle", () => {
    assert.equal(csnapsPath({ SLATE_CSNAPS_BIN: "  /opt/csnaps  " } as never), "/opt/csnaps");
    const byDefault = csnapsPath({} as never);
    assert.equal(byDefault.endsWith(join("extensions", "codebase-telemetry", "csnaps")), true);
  });

  it("says it is missing when there is nothing there", () => {
    const missing = join(scratch(), "nothing");
    assert.deepEqual(csnapsAvailability({ SLATE_CSNAPS_BIN: missing } as never), { available: false, executablePath: missing, reason: "missing" });
  });

  it("says it is not a file when something that is not one is there", () => {
    const directory = scratch();
    assert.deepEqual(csnapsAvailability({ SLATE_CSNAPS_BIN: directory } as never), { available: false, executablePath: directory, reason: "not-file" });
  });

  it("says it cannot be run when the file is not executable, and that it is available when it is", () => {
    const root = scratch();
    const path = join(root, "csnaps");
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o644);
    assert.deepEqual(csnapsAvailability({ SLATE_CSNAPS_BIN: path } as never), { available: false, executablePath: path, reason: "not-executable" });
    chmodSync(path, 0o755);
    assert.deepEqual(csnapsAvailability({ SLATE_CSNAPS_BIN: path } as never), { available: true, executablePath: path });
  });
});
