import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  SlatePendingWakeStore,
  coerceMarker,
  coercePendingWakeMarkers,
  coerceQuietOrigin,
  markerKeyMatches,
  parsePendingWakeFile,
  upsertPendingWakeMarker,
} from "../../source/host/transcript/slate-pending-wake-store.ts";

const roots: string[] = [];
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pending-wake-"));
  roots.push(root);
  return root;
}
after(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const marker = (overrides: Record<string, unknown> = {}) => ({ agentId: "agent-1", kind: "shell", workId: "work-1", markedAtMs: 1000, ...overrides }) as never;

describe("reading pending wake markers", () => {
  it("coerces the quiet origin", () => {
    assert.equal(coerceQuietOrigin(null), null);
    assert.equal(coerceQuietOrigin(undefined), null);
    assert.equal(coerceQuietOrigin("nope"), null);
    assert.deepEqual(coerceQuietOrigin({}), {});
    assert.deepEqual(coerceQuietOrigin({ automation: "nope" }), {});
    assert.deepEqual(coerceQuietOrigin({ automation: { id: "a1", name: "Automation" } }), { automation: { id: "a1", name: "Automation" } });
  });

  it("coerces a marker with its optional fields", () => {
    assert.equal(coerceMarker(null), null);
    assert.equal(coerceMarker("nope"), null);
    assert.equal(coerceMarker({ agentId: "", kind: "shell", workId: "w" }), null);
    assert.equal(coerceMarker({ agentId: "a", kind: "nope", workId: "w" }), null);
    assert.deepEqual(coerceMarker({ agentId: "a", kind: "subagent", workId: "w" }), { agentId: "a", kind: "subagent", workId: "w", markedAtMs: 0 });
    const full = coerceMarker(marker({ quietOrigin: { automation: { id: "a1", name: "A" } }, title: "T", subagentType: "S", interruptedByRecreate: true }));
    assert.deepEqual(full, { agentId: "agent-1", kind: "shell", workId: "work-1", markedAtMs: 1000, quietOrigin: { automation: { id: "a1", name: "A" } }, title: "T", subagentType: "S", interruptedByRecreate: true });
    assert.deepEqual(coercePendingWakeMarkers([marker(), "nope", null]), [marker()]);
    assert.deepEqual(coercePendingWakeMarkers("nope"), []);
  });

  it("parses a pending wake file and ignores a broken one", () => {
    assert.deepEqual(parsePendingWakeFile(null), []);
    assert.deepEqual(parsePendingWakeFile("not json"), []);
    assert.deepEqual(parsePendingWakeFile(JSON.stringify({ pending: [marker()] })), [marker()]);
    assert.deepEqual(parsePendingWakeFile(JSON.stringify({ pending: "nope" })), []);
    assert.deepEqual(parsePendingWakeFile(JSON.stringify("nope")), []);
  });

  it("matches and upserts by the marker key", () => {
    assert.equal(markerKeyMatches(marker(), "agent-1", "shell", "work-1"), true);
    assert.equal(markerKeyMatches(marker(), "agent-2", "shell", "work-1"), false);
    const replaced = upsertPendingWakeMarker([marker({ markedAtMs: 1 }), marker({ workId: "work-2" })], marker({ markedAtMs: 2 }));
    assert.deepEqual(replaced, [marker({ workId: "work-2" }), marker({ markedAtMs: 2 })]);
  });
});

describe("the pending wake store", () => {
  it("marks, lists and clears wakes", () => {
    const store = new SlatePendingWakeStore(freshRoot());
    assert.deepEqual(store.listPending(), []);
    assert.equal(store.markPending(marker()), true);
    assert.equal(store.markPending(marker({ workId: "work-2" })), true);
    assert.equal(store.hasPending("agent-1", "shell", "work-1"), true);
    assert.equal(store.hasPending("agent-1", "shell", "missing"), false);
    assert.equal(store.listPending().length, 2);
    assert.equal(store.clearOne("agent-1", "shell", "work-1"), true);
    assert.equal(store.clearOne("agent-1", "shell", "work-1"), false);
    assert.equal(store.listPending().length, 1);
    store.clearAgent("agent-1");
    assert.deepEqual(store.listPending(), []);
    assert.equal(store.markPending(marker()), true);
    store.clearAll();
    assert.deepEqual(store.listPending(), []);
  });

  it("prunes stale wakes and keeps the fresh ones", () => {
    const store = new SlatePendingWakeStore(freshRoot());
    store.markPending(marker({ markedAtMs: 1_000 }));
    store.markPending(marker({ workId: "fresh", markedAtMs: 9_000 }));
    const stale = store.pruneStale(5_000, 10_000);
    assert.deepEqual(stale.map((entry) => entry.workId), ["work-1"]);
    assert.deepEqual(store.listPending().map((entry) => entry.workId), ["fresh"]);
    assert.deepEqual(store.pruneStale(5_000, 10_000), []);
  });

  it("reads a broken or missing file as empty and writes atomically", () => {
    const root = freshRoot();
    const store = new SlatePendingWakeStore(root);
    writeFileSync(store.filePath, "not json");
    assert.deepEqual(store.listPending(), []);
    assert.equal(store.markPending(marker()), true);
    const written = JSON.parse(readFileSync(store.filePath, "utf8")) as { version: number; pending: unknown[] };
    assert.equal(written.version, 1);
    assert.equal(written.pending.length, 1);
    assert.equal(store.markPending({ agentId: "bad" } as never), true);
  });

  it("returns false when the file cannot be written", () => {
    const root = freshRoot();
    const store = new SlatePendingWakeStore(root);
    mkdirSync(store.filePath, { recursive: true });
    assert.equal(store.markPending(marker()), false);
  });
});
