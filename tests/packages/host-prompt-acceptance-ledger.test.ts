/**
 * The ledger of what a prompt accepted: what a nonce means on a replay, what the ledger remembers it forgot, and what it
 * does when it cannot write.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  DEGRADED_WINDOW_CAP,
  MAX_RECORDS,
  NO_GAPS,
  PromptAcceptanceDigestMismatchError,
  PromptAcceptanceLedger,
  PromptAcceptanceRejectedError,
  SLATE_SEND_ACCEPTANCE_FILE_NAME,
  gapsAfterCorruptReset,
  gapsAfterDegradedWindow,
  gapsAfterEviction,
  readAcceptanceRecord,
  readAcceptanceSnapshot,
  readGaps,
  sendInputDigest,
  sendInputShape,
} from "../../source/host/transcript/prompt-acceptance-ledger.ts";

/** A ledger in a directory of its own, cleaned up afterwards. */
async function withLedger(run: (ledger: PromptAcceptanceLedger, directory: string, clock: { now: number }) => Promise<void> | void) {
  const directory = mkdtempSync(join(tmpdir(), "slate-acceptance-"));
  const clock = { now: 1_000 };
  const ledger = new PromptAcceptanceLedger(directory, () => clock.now);
  try {
    await run(ledger, directory, clock);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const record = (overrides: Record<string, unknown> = {}) => ({
  accountSlot: "slot-1",
  clientNonce: "nonce-1",
  inputDigest: "digest-1",
  status: "pending",
  acceptedAtMs: 5,
  agentId: "agent-1",
  echoEntryId: null,
  rejectionCode: null,
  ...overrides,
});

describe("what a send's input hashes to", () => {
  it("is stable for the same input, in one order, and changes with every field that matters", () => {
    const input = { agentId: "agent-1", prompt: "hello", attachmentPaths: ["a"], isFork: true };
    assert.equal(sendInputShape(input), sendInputShape({ ...input, attachmentPaths: ["a"] }));
    const digest = sendInputDigest(input);
    assert.equal(digest, sendInputDigest({ ...input }));
    for (const changed of [{ prompt: "hello!" }, { agentId: "agent-2" }, { richText: "x" }, { replyToId: "m1" }, { isFork: false }, { attachmentPaths: ["b"] }]) {
      assert.notEqual(sendInputDigest({ ...input, ...changed }), digest, JSON.stringify(changed));
    }
    // `isFork` is true only when it is literally true, and the arrays are copied rather than referenced.
    assert.equal(sendInputShape({ prompt: "p", isFork: 1 as never }), sendInputShape({ prompt: "p", isFork: false }));
  });
});

describe("reading a ledger file", () => {
  it("reads a good file, keeps the records it can and says when it could not read the rest", () => {
    const good = readAcceptanceSnapshot(JSON.stringify({ version: 1, records: [record()], historyGaps: { evictionHorizonMs: 3, degradedWindows: [{ fromMs: 1, toMs: 2 }], corruptResetAtMs: null } }));
    assert.deepEqual([good.damaged, good.records.length, good.gaps?.evictionHorizonMs], [false, 1, 3]);
    assert.deepEqual(readAcceptanceSnapshot(null), { records: [], gaps: null, damaged: false });
    assert.deepEqual(readAcceptanceSnapshot("not json"), { records: [], gaps: null, damaged: true });
    assert.deepEqual(readAcceptanceSnapshot(JSON.stringify({ version: 1 })), { records: [], gaps: null, damaged: true });
    // One unusable record damages the file, and the usable ones still come back.
    const partial = readAcceptanceSnapshot(JSON.stringify({ version: 1, records: [record(), { ...record({ clientNonce: "n2" }), status: "nonsense" }] }));
    assert.deepEqual([partial.damaged, partial.records.length], [true, 1]);
    // Gaps that cannot be read are dropped, and the file counts as damaged.
    const badGaps = readAcceptanceSnapshot(JSON.stringify({ version: 1, records: [], historyGaps: { evictionHorizonMs: "soon", degradedWindows: [] } }));
    assert.deepEqual([badGaps.damaged, badGaps.gaps], [true, null]);
  });

  it("refuses a record without the fields it needs, and fills the optional ones with null", () => {
    for (const broken of [
      { accountSlot: "" },
      { clientNonce: "" },
      { inputDigest: "" },
      { agentId: "" },
      { status: "unknown" },
      { acceptedAtMs: Number.NaN },
      { acceptedAtMs: "5" },
    ]) {
      assert.equal(readAcceptanceRecord(record(broken)), null, JSON.stringify(broken));
    }
    assert.equal(readAcceptanceRecord(null), null);
    const read = readAcceptanceRecord(record({ echoEntryId: 7, rejectionCode: undefined }));
    assert.deepEqual([read?.echoEntryId, read?.rejectionCode], [null, null]);
  });

  it("reads the gap history strictly, because a gap that cannot be read is not an empty history", () => {
    assert.equal(readGaps(null), null);
    assert.equal(readGaps("x"), "malformed");
    assert.deepEqual(readGaps({ degradedWindows: [] }), NO_GAPS);
    assert.equal(readGaps({ degradedWindows: [], evictionHorizonMs: "1" }), "malformed");
    assert.equal(readGaps({ degradedWindows: [{ fromMs: 1 }] }), "malformed");
    assert.deepEqual(readGaps({ degradedWindows: [{ fromMs: 1, toMs: 2 }], corruptResetAtMs: 4 }), { evictionHorizonMs: null, degradedWindows: [{ fromMs: 1, toMs: 2 }], corruptResetAtMs: 4 });
  });

  it("updates gaps from whatever exists, and collapses the windows past the cap", () => {
    assert.deepEqual(gapsAfterEviction(null, 10), { ...NO_GAPS, evictionHorizonMs: 10 });
    assert.equal(gapsAfterEviction({ ...NO_GAPS, evictionHorizonMs: 20 }, 10).evictionHorizonMs, 20);
    assert.equal(gapsAfterCorruptReset({ ...NO_GAPS, corruptResetAtMs: 5 }, 2).corruptResetAtMs, 5);
    let gaps = NO_GAPS;
    for (let index = 0; index < DEGRADED_WINDOW_CAP; index += 1) gaps = gapsAfterDegradedWindow(gaps, { fromMs: index, toMs: index + 100 });
    assert.equal(gaps.degradedWindows.length, DEGRADED_WINDOW_CAP);
    // Past the cap the last window grows instead of one more being kept: what was open stays covered.
    const collapsed = gapsAfterDegradedWindow(gaps, { fromMs: 500, toMs: 600 });
    assert.equal(collapsed.degradedWindows.length, DEGRADED_WINDOW_CAP);
    assert.deepEqual(collapsed.degradedWindows.at(-1), { fromMs: DEGRADED_WINDOW_CAP - 1, toMs: 600 });
    // A window that starts before the one it merges with extends the merged window back to that start.
    const earlier = gapsAfterDegradedWindow(collapsed, { fromMs: 1, toMs: 700 });
    assert.deepEqual(earlier.degradedWindows.at(-1), { fromMs: 1, toMs: 700 });
  });
});

describe("a nonce, once", () => {
  it("dispatches an unknown nonce, and answers a known one with what happened to it", async () => {
    await withLedger(async (ledger) => {
      assert.deepEqual(ledger.lookup({ accountSlot: "s", clientNonce: "n" }), { outcome: "not-found" });
      const pending = ledger.recordPending({ accountSlot: "s", clientNonce: "n", inputDigest: "d", agentId: "a", echoEntryId: null });
      assert.deepEqual([pending.status, pending.acceptedAtMs, pending.rejectionCode], ["pending", 1_000, null]);
      assert.deepEqual(ledger.admitSend({ accountSlot: "s", clientNonce: "n", inputDigest: "d" }), { kind: "duplicate", record: pending });
      // The same nonce with a different input is refused, whether it is pending, accepted or rejected.
      assert.throws(() => ledger.admitSend({ accountSlot: "s", clientNonce: "n", inputDigest: "other" }), (error: unknown) => error instanceof PromptAcceptanceDigestMismatchError);
      assert.throws(() => ledger.recordPending({ accountSlot: "s", clientNonce: "n", inputDigest: "other", agentId: "a", echoEntryId: null }), PromptAcceptanceDigestMismatchError);
      ledger.markAccepted({ accountSlot: "s", clientNonce: "n" });
      assert.equal(ledger.lookup({ accountSlot: "s", clientNonce: "n" }).outcome, "found");
      // A settled record keeps its outcome: a second rejection does not overwrite the acceptance.
      ledger.markRejected({ accountSlot: "s", clientNonce: "n", rejectionCode: "nope" });
      const settled = ledger.lookup({ accountSlot: "s", clientNonce: "n" });
      assert.equal(settled.outcome === "found" ? settled.record.status : "", "accepted");
    });
  });

  it("replays a rejection instead of sending again", async () => {
    await withLedger(async (ledger) => {
      ledger.recordPending({ accountSlot: "s", clientNonce: "n", inputDigest: "d", agentId: "a", echoEntryId: null });
      ledger.markRejected({ accountSlot: "s", clientNonce: "n", rejectionCode: "quota" });
      assert.throws(() => ledger.admitSend({ accountSlot: "s", clientNonce: "n", inputDigest: "d" }), (error: unknown) => error instanceof PromptAcceptanceRejectedError && /quota/.test(error.message));
      // A rejected nonce whose code is empty still says it was rejected.
      ledger.recordPending({ accountSlot: "s", clientNonce: "n2", inputDigest: "d", agentId: "a", echoEntryId: null });
      ledger.markRejected({ accountSlot: "s", clientNonce: "n2", rejectionCode: "" });
      assert.throws(() => ledger.admitSend({ accountSlot: "s", clientNonce: "n2", inputDigest: "d" }), /send rejected: /);
    });
  });

  it("keeps what it recorded across a restart, and forgets a cleared nonce", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-acceptance-"));
    try {
      const first = new PromptAcceptanceLedger(directory, () => 7);
      first.recordPending({ accountSlot: "s", clientNonce: "n", inputDigest: "d", agentId: "a", echoEntryId: null });
      first.dispose();
      assert.equal(existsSync(join(directory, SLATE_SEND_ACCEPTANCE_FILE_NAME)), true);
      const second = new PromptAcceptanceLedger(directory, () => 8);
      assert.equal(second.lookup({ accountSlot: "s", clientNonce: "n" }).outcome, "found");
      // Clearing drops it for good; clearing a nonce that was accepted leaves it alone.
      second.clear({ accountSlot: "s", clientNonce: "n" });
      assert.equal(second.lookup({ accountSlot: "s", clientNonce: "n" }).outcome, "not-found");
      second.recordPending({ accountSlot: "s", clientNonce: "kept", inputDigest: "d", agentId: "a", echoEntryId: null });
      second.markAccepted({ accountSlot: "s", clientNonce: "kept" });
      second.clearUnlessAccepted({ accountSlot: "s", clientNonce: "kept" });
      assert.equal(second.lookup({ accountSlot: "s", clientNonce: "kept" }).outcome, "found");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps a bounded ledger, and calls an old unknown nonce unknown rather than unseen", async () => {
    await withLedger(async (ledger, _directory, clock) => {
      for (let index = 0; index <= MAX_RECORDS; index += 1) {
        clock.now = 2_000 + index;
        ledger.recordPending({ accountSlot: "s", clientNonce: `n${index}`, inputDigest: "d", agentId: "a", echoEntryId: null });
      }
      // The first nonce was evicted, and the horizon makes that visible instead of pretending it never existed.
      assert.equal(ledger.lookup({ accountSlot: "s", clientNonce: "n0" }).outcome, "unknown-durability");
      assert.equal(ledger.lookup({ accountSlot: "s", clientNonce: `n${MAX_RECORDS}` }).outcome, "found");
    });
  });

  it("treats an unreadable ledger as damage: keeps a copy, reopens as degraded", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-acceptance-"));
    try {
      writeFileSync(join(directory, SLATE_SEND_ACCEPTANCE_FILE_NAME), "{ this is not json");
      const ledger = new PromptAcceptanceLedger(directory, () => 42);
      assert.equal(ledger.lookup({ accountSlot: "s", clientNonce: "n" }).outcome, "unknown-durability");
      assert.deepEqual(readdirSync(directory).filter((name) => name.includes(".corrupt-")).length, 1);
      // The readable file now records the reset, so a second open still knows the history has a hole.
      const again = new PromptAcceptanceLedger(directory, () => 43);
      assert.equal(again.lookup({ accountSlot: "s", clientNonce: "n" }).outcome, "unknown-durability");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reopens a degraded window from its marker, and closes the marker once it writes again", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-acceptance-"));
    try {
      const marker = `${join(directory, SLATE_SEND_ACCEPTANCE_FILE_NAME)}.degraded`;
      writeFileSync(marker, JSON.stringify({ version: 1, sinceMs: 5 }));
      const ledger = new PromptAcceptanceLedger(directory, () => 10);
      assert.equal(ledger.lookup({ accountSlot: "s", clientNonce: "n" }).outcome, "unknown-durability");
      // That load persisted, so the window is in the file and the marker is gone.
      assert.equal(existsSync(marker), false);
      const history = JSON.parse(readFileSync(join(directory, SLATE_SEND_ACCEPTANCE_FILE_NAME), "utf8"));
      assert.deepEqual(history.historyGaps.degradedWindows, [{ fromMs: 5, toMs: 10 }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("opens a degraded window when it cannot write, and keeps answering unknown meanwhile", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-acceptance-"));
    try {
      // A directory where the ledger file should be makes the rename fail without making the directory unwritable.
      mkdirSync(join(directory, SLATE_SEND_ACCEPTANCE_FILE_NAME));
      const ledger = new PromptAcceptanceLedger(directory, () => 11);
      ledger.recordPending({ accountSlot: "s", clientNonce: "n", inputDigest: "d", agentId: "a", echoEntryId: null });
      assert.equal(ledger.lookup({ accountSlot: "s", clientNonce: "other" }).outcome, "unknown-durability");
      assert.equal(existsSync(`${join(directory, SLATE_SEND_ACCEPTANCE_FILE_NAME)}.degraded`), true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
