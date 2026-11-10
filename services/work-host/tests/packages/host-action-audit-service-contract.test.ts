import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CONNECT_CODE_RESOURCE_EXHAUSTED } from "../../source/adapters/interop/connect/connect-error-adapter.ts";
import type { PollingPolicy } from "../../source/host/extensions/scheduling.ts";
import {
  ACTION_AUDIT_FLUSH_INTERVAL_MS,
  AUDIT_FLUSH_FAILURE_BACKOFF_MS,
  createSlateActionAuditor,
  flushFailureBackoffMs,
  isBackendForwardable,
  localAuditJsonlLine,
  MAX_AUDIT_BATCH_SIZE,
  MAX_PENDING_AUDIT_EVENTS,
  type AuditAction,
  type AuditEvent,
  type AuditRecord,
} from "../../source/host/extensions/action-audit/action-audit-service.ts";

interface ManualPoller {
  readonly policy: PollingPolicy;
  fire(): Promise<void>;
  disposed(): number;
}

function manualPoller(): ManualPoller {
  let tick: (() => Promise<void>) | undefined;
  let disposeCount = 0;
  return {
    policy: {
      name: "manual-audit-poll",
      start(callback) {
        tick = callback;
        return { dispose: () => { disposeCount += 1; } };
      },
    },
    async fire() {
      await tick?.();
    },
    disposed: () => disposeCount,
  };
}

function auditRecord(action: AuditAction, overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    occurredAtMs: 1_700_000_000_123,
    agentId: "agent-a",
    action,
    ...overrides,
  };
}

interface WorldOptions {
  readonly enabled?: boolean;
  readonly nowMs?: number;
  readonly sendBatch?: (events: readonly AuditEvent[]) => Promise<void>;
  readonly appendLocalLine?: (path: string, line: string) => Promise<void>;
  readonly randomId?: () => string;
}

function world(options: WorldOptions = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), "slate-action-audit-contract-"));
  const outboxPath = join(rootDir, "audit-outbox.json");
  let enabled = options.enabled ?? true;
  let nowMs = options.nowMs ?? 50_000;
  let generatedId = 0;
  const sent: AuditEvent[][] = [];
  const localLines: Array<{ path: string; line: string }> = [];
  const reports: unknown[] = [];
  const poller = manualPoller();
  const service = createSlateActionAuditor({
    isBackendForwardingEnabled: () => enabled,
    sendBatch: async (events) => {
      sent.push([...events]);
      await options.sendBatch?.(events);
    },
    flushPolicy: poller.policy,
    report: (value) => reports.push(value),
    now: () => nowMs,
    randomId: options.randomId ?? (() => `event-${++generatedId}`),
    outboxPath,
    auditPath: (agentId) => join(rootDir, `${agentId}.jsonl`),
    appendLocalLine: async (path, line) => {
      localLines.push({ path, line });
      await options.appendLocalLine?.(path, line);
    },
  });
  return {
    rootDir,
    outboxPath,
    service,
    poller,
    sent,
    localLines,
    reports,
    setEnabled(value: boolean) { enabled = value; },
    setNow(value: number) { nowMs = value; },
    cleanup() { rmSync(rootDir, { recursive: true, force: true }); },
  };
}

async function withWorld(run: (value: ReturnType<typeof world>) => Promise<void>, options: WorldOptions = {}): Promise<void> {
  const value = world(options);
  try {
    await run(value);
  } finally {
    await value.service.dispose();
    value.cleanup();
  }
}

function persistedEvents(outboxPath: string): AuditEvent[] {
  return JSON.parse(readFileSync(outboxPath, "utf8")) as AuditEvent[];
}

test("audit limits, polling interval, and the fixed failure delay are product values", () => {
  assert.deepEqual([
    ACTION_AUDIT_FLUSH_INTERVAL_MS,
    MAX_AUDIT_BATCH_SIZE,
    MAX_PENDING_AUDIT_EVENTS,
    AUDIT_FLUSH_FAILURE_BACKOFF_MS,
  ], [5_000, 50, 2_000, 30_000]);
  assert.equal(flushFailureBackoffMs(new Error("offline"), 10_000), 30_000);
});

test("a rate limit extends the retry delay to the later of retry-after or the floor", () => {
  const rateLimited = {
    code: CONNECT_CODE_RESOURCE_EXHAUSTED,
    metadata: { get: (name: string) => name === "retry-after" ? "45" : null },
  };
  const briefLimit = {
    code: CONNECT_CODE_RESOURCE_EXHAUSTED,
    metadata: { get: (name: string) => name === "retry-after" ? "2" : null },
  };
  assert.equal(flushFailureBackoffMs(rateLimited, 10_000), 45_000);
  assert.equal(flushFailureBackoffMs(briefLimit, 10_000), 30_000);
  assert.equal(flushFailureBackoffMs({ ...rateLimited, code: 13 }, 10_000), 30_000);
});

test("only MCP calls using stdio are eligible for backend forwarding", () => {
  assert.equal(isBackendForwardable(auditRecord({ kind: "mcpToolCall", toolCallId: "c", serverIdentifier: "s", toolName: "read", transport: "stdio", status: "ok", durationMs: 1 })), true);
  assert.equal(isBackendForwardable(auditRecord({ kind: "mcpToolCall", toolCallId: "c", serverIdentifier: "s", toolName: "read", transport: "http", status: "ok", durationMs: 1 })), false);
  assert.equal(isBackendForwardable(auditRecord({ kind: "browserNavigation", url: "https://example.test", pageTitle: "Example" })), true);
  assert.equal(isBackendForwardable(auditRecord({ kind: "shellCommand", command: "ls", shellKind: "bash", target: "." })), true);
  assert.equal(isBackendForwardable(auditRecord({ kind: "computerUseSession", actionCount: 1, actionCounts: {}, durationMs: 5, screenshotCount: 0 })), true);
});

test("local JSONL rows keep their date and action-specific fields", () => {
  const base = { occurredAtMs: 1_700_000_000_123, agentId: "agent-a", turnId: "turn-a", boxId: "box-a" };
  const lines = [
    localAuditJsonlLine({ ...base, action: { kind: "mcpToolCall", toolCallId: "call-1", serverIdentifier: "server", serverName: "Local label", toolName: "read", transport: "stdio", status: "ok", durationMs: 12 } }, "id-1"),
    localAuditJsonlLine({ ...base, action: { kind: "browserNavigation", url: "https://example.test", pageTitle: "Example" } }, "id-2"),
    localAuditJsonlLine({ ...base, action: { kind: "computerUseSession", actionCount: 3, actionCounts: { click: 2 }, durationMs: 99, screenshotCount: 1 } }, "id-3"),
    localAuditJsonlLine({ ...base, action: { kind: "shellCommand", command: "git status", shellKind: "bash", target: "/repo", allowed: false, blockedReason: "policy", classificationReasons: ["write"] } }, "id-4"),
  ];
  const rows = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(rows.map((row) => row.type), ["mcp_tool_call", "browser_navigation", "computer_use_session", "shell_command"]);
  assert.deepEqual(rows.map((row) => row.eventId), ["id-1", "id-2", "id-3", "id-4"]);
  assert.deepEqual(rows.map((row) => row.ts), ["2023-11-14T22:13:20.123Z", "2023-11-14T22:13:20.123Z", "2023-11-14T22:13:20.123Z", "2023-11-14T22:13:20.123Z"]);
  assert.deepEqual([rows[0]?.serverIdentifier, rows[0]?.toolCallId, rows[0]?.transport, rows[0]?.status, rows[0]?.durationMs], ["server", "call-1", "stdio", "ok", 12]);
  assert.equal("serverName" in (rows[0] ?? {}), false);
  assert.deepEqual([rows[1]?.url, rows[1]?.pageTitle], ["https://example.test", "Example"]);
  assert.deepEqual([rows[2]?.toolCallId, rows[2]?.actionCount, rows[2]?.actionCounts, rows[2]?.screenshotCount], ["", 3, { click: 2 }, 1]);
  assert.deepEqual([rows[3]?.command, rows[3]?.shellKind, rows[3]?.target], ["git status", "bash", "/repo"]);
  assert.equal("blockedReason" in (rows[3] ?? {}), false);
  assert.equal(lines.every((line) => line.endsWith("\n")), true);
});

test("local rows omit box ids and include turn ids only when nonempty", () => {
  const withoutTurn = JSON.parse(localAuditJsonlLine(auditRecord({ kind: "browserNavigation", url: "u", pageTitle: "p" }), "e"));
  const withTurn = JSON.parse(localAuditJsonlLine(auditRecord({ kind: "browserNavigation", url: "u", pageTitle: "p" }, { turnId: "turn-a", boxId: "box-a" }), "e"));
  assert.equal("turnId" in withoutTurn, false);
  assert.equal("boxId" in withTurn, false);
  assert.equal(withTurn.turnId, "turn-a");
});

test("recording writes every local action even when a transport is not backend-forwardable", async () => {
  await withWorld(async (value) => {
    value.service.auditor.record(auditRecord({ kind: "mcpToolCall", toolCallId: "c", serverIdentifier: "s", toolName: "read", transport: "http", status: "ok", durationMs: 4 }));
    await value.service.flush();
    await value.service.dispose();
    assert.equal(value.sent.length, 0);
    assert.equal(value.localLines.length, 1);
    assert.equal(JSON.parse(value.localLines[0]?.line ?? "{}").type, "mcp_tool_call");
    assert.equal(existsSync(value.outboxPath), false);
  });
});

test("backend events carry generated ids and empty values for missing turn and box ids", async () => {
  await withWorld(async (value) => {
    value.service.auditor.record(auditRecord({ kind: "browserNavigation", url: "https://example.test", pageTitle: "Example" }));
    await value.service.flush();
    assert.deepEqual(value.sent[0], [{
      eventId: "event-1",
      occurredAtMs: 1_700_000_000_123,
      agentId: "agent-a",
      turnId: "",
      boxId: "",
      action: { kind: "browserNavigation", url: "https://example.test", pageTitle: "Example" },
    }]);
  });
});

test("the first poll tick warms the schedule; the next tick flushes", async () => {
  await withWorld(async (value) => {
    value.service.auditor.record(auditRecord({ kind: "browserNavigation", url: "u", pageTitle: "p" }));
    await value.poller.fire();
    assert.equal(value.sent.length, 0);
    await value.poller.fire();
    assert.equal(value.sent.length, 1);
    assert.equal(value.poller.disposed(), 0);
  });
});

test("a disabled forwarding gate persists pending rows until the gate opens", async () => {
  await withWorld(async (value) => {
    value.setEnabled(false);
    value.service.auditor.record(auditRecord({ kind: "browserNavigation", url: "u", pageTitle: "p" }));
    await value.service.flush();
    assert.equal(value.sent.length, 0);
    assert.equal(persistedEvents(value.outboxPath)[0]?.eventId, "event-1");
    value.setEnabled(true);
    await value.service.flush();
    assert.deepEqual(value.sent.map((batch) => batch.map((event) => event.eventId)), [["event-1"]]);
    assert.equal(existsSync(value.outboxPath), false);
  }, { enabled: false });
});

test("flush drains all rows in ordered batches no larger than fifty", async () => {
  await withWorld(async (value) => {
    for (let index = 0; index < 123; index += 1) {
      value.service.auditor.record(auditRecord({ kind: "browserNavigation", url: `https://example.test/${index}`, pageTitle: String(index) }));
    }
    await value.service.flush();
    assert.deepEqual(value.sent.map((batch) => batch.length), [50, 50, 23]);
    assert.deepEqual(value.sent.flat().map((event) => event.eventId), Array.from({ length: 123 }, (_, index) => `event-${index + 1}`));
  });
});

test("an outbox survives a send failure and waits until the retry deadline", async () => {
  let attempts = 0;
  await withWorld(async (value) => {
    value.service.auditor.record(auditRecord({ kind: "browserNavigation", url: "u", pageTitle: "p" }));
    await value.service.flush();
    assert.deepEqual(value.sent.map((batch) => batch.map((event) => event.eventId)), [["event-1"]]);
    assert.deepEqual(persistedEvents(value.outboxPath).map((event) => event.eventId), ["event-1"]);
    await value.service.flush();
    assert.equal(value.sent.length, 1, "a flush before backoff expiry is a no-op");
    value.setNow(80_000);
    await value.service.flush();
    assert.deepEqual(value.sent[1]?.map((event) => event.eventId), ["event-1"]);
    assert.equal(existsSync(value.outboxPath), false);
  }, {
    nowMs: 50_000,
    sendBatch: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
    },
  });
});

test("rate-limit retry-after metadata controls the auditor's next flush time", async () => {
  let attempts = 0;
  await withWorld(async (value) => {
    value.service.auditor.record(auditRecord({ kind: "browserNavigation", url: "u", pageTitle: "p" }));
    await value.service.flush();
    assert.equal(attempts, 1);
    value.setNow(94_999);
    await value.service.flush();
    assert.equal(attempts, 1);
    value.setNow(95_000);
    await value.service.flush();
    assert.equal(attempts, 2);
  }, {
    nowMs: 50_000,
    sendBatch: async () => {
      attempts += 1;
      if (attempts === 1) throw {
        code: CONNECT_CODE_RESOURCE_EXHAUSTED,
        metadata: { get: (name: string) => name === "retry-after" ? "45" : null },
      };
    },
  });
});

test("overlapping flush calls share one in-flight batch", async () => {
  let beginSend!: () => void;
  let releaseSend!: () => void;
  const sendStarted = new Promise<void>((resolve) => { beginSend = resolve; });
  const release = new Promise<void>((resolve) => { releaseSend = resolve; });
  await withWorld(async (value) => {
    value.service.auditor.record(auditRecord({ kind: "browserNavigation", url: "u", pageTitle: "p" }));
    const first = value.service.flush();
    const didSendStart = await Promise.race([
      sendStarted.then(() => true),
      new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 250);
        void sendStarted.then(() => clearTimeout(timeout));
      }),
    ]);
    assert.equal(didSendStart, true, "flush must start its one pending batch");
    const second = value.service.flush();
    assert.equal(second, first);
    releaseSend();
    await Promise.all([first, second]);
    assert.equal(value.sent.length, 1);
  }, { sendBatch: async () => { beginSend(); await release; } });
});

test("recording beyond the pending limit retains the newest two thousand events", async () => {
  await withWorld(async (value) => {
    value.setEnabled(false);
    for (let index = 0; index < MAX_PENDING_AUDIT_EVENTS + 5; index += 1) {
      value.service.auditor.record(auditRecord({ kind: "browserNavigation", url: String(index), pageTitle: "p" }));
    }
    await value.service.flush();
    const stored = persistedEvents(value.outboxPath);
    assert.equal(stored.length, MAX_PENDING_AUDIT_EVENTS);
    assert.deepEqual([stored[0]?.eventId, stored.at(-1)?.eventId], ["event-6", "event-2005"]);
    assert.equal(value.sent.length, 0);
  }, { enabled: false, appendLocalLine: async () => {} });
});

test("persisted rows are sent before new in-memory rows", async () => {
  await withWorld(async (value) => {
    const existing: AuditEvent = {
      eventId: "persisted-1",
      occurredAtMs: 1,
      agentId: "old-agent",
      turnId: "old-turn",
      boxId: "old-box",
      action: { kind: "browserNavigation", url: "old", pageTitle: "Old" },
    };
    writeFileSync(value.outboxPath, JSON.stringify([existing]));
    value.service.auditor.record(auditRecord({ kind: "browserNavigation", url: "new", pageTitle: "New" }));
    await value.service.flush();
    assert.deepEqual(value.sent[0]?.map((event) => event.eventId), ["persisted-1", "event-1"]);
  });
});

test("loading persisted rows reserves only the remaining pending capacity for new rows", async () => {
  await withWorld(async (value) => {
    const saved = Array.from({ length: MAX_PENDING_AUDIT_EVENTS - 1 }, (_, index): AuditEvent => ({
      eventId: `stored-${index + 1}`,
      occurredAtMs: index,
      agentId: "agent-saved",
      turnId: "",
      boxId: "",
      action: { kind: "browserNavigation", url: String(index), pageTitle: "Saved" },
    }));
    writeFileSync(value.outboxPath, JSON.stringify(saved));
    value.service.auditor.record(auditRecord({ kind: "browserNavigation", url: "new-1", pageTitle: "New 1" }));
    value.service.auditor.record(auditRecord({ kind: "browserNavigation", url: "new-2", pageTitle: "New 2" }));
    await value.service.flush();
    const stored = persistedEvents(value.outboxPath);
    assert.equal(stored.length, MAX_PENDING_AUDIT_EVENTS);
    assert.equal(stored.at(-1)?.eventId, "event-2");
  }, { enabled: false, appendLocalLine: async () => {} });
});

test("an oversized saved outbox only restores its first two thousand rows", async () => {
  await withWorld(async (value) => {
    const saved = Array.from({ length: MAX_PENDING_AUDIT_EVENTS + 1 }, (_, index): AuditEvent => ({
      eventId: `stored-${index + 1}`,
      occurredAtMs: index,
      agentId: "agent-saved",
      turnId: "",
      boxId: "",
      action: { kind: "browserNavigation", url: String(index), pageTitle: "Saved" },
    }));
    writeFileSync(value.outboxPath, JSON.stringify(saved));
    await value.service.flush();
    const ids = value.sent.flat().map((event) => event.eventId);
    assert.equal(ids.length, MAX_PENDING_AUDIT_EVENTS);
    assert.deepEqual([ids[0], ids.at(-1)], ["stored-1", "stored-2000"]);
  });
});

test("an invalid outbox is ignored and removed when there is nothing to deliver", async () => {
  await withWorld(async (value) => {
    writeFileSync(value.outboxPath, "not json");
    await value.service.flush();
    assert.deepEqual(value.sent, []);
    assert.equal(existsSync(value.outboxPath), false);
  });
});

test("a failed local append is reported without losing the backend event", async () => {
  await withWorld(async (value) => {
    value.service.auditor.record(auditRecord({ kind: "browserNavigation", url: "u", pageTitle: "p" }));
    await value.service.flush();
    await value.service.dispose();
    assert.equal(value.sent.length, 1);
    assert.deepEqual(value.reports, [{ extension: "action_audit", errorClass: "Error" }]);
  }, { appendLocalLine: async () => { throw new Error("disk full"); } });
});

test("a broken id source is swallowed and does not create a local or backend event", async () => {
  await withWorld(async (value) => {
    value.service.auditor.record(auditRecord({ kind: "browserNavigation", url: "u", pageTitle: "p" }));
    await value.service.flush();
    await value.service.dispose();
    assert.deepEqual(value.sent, []);
    assert.deepEqual(value.localLines, []);
    assert.deepEqual(value.reports, []);
  }, { randomId: () => { throw new Error("id source failed"); } });
});

test("local file writes run in order and dispose waits for the queued tail", async () => {
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let startedFirst!: () => void;
  let startedSecond!: () => void;
  const firstStarted = new Promise<void>((resolve) => { startedFirst = resolve; });
  const secondStarted = new Promise<void>((resolve) => { startedSecond = resolve; });
  const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const holdSecond = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const writeOrder: string[] = [];
  await withWorld(async (value) => {
    value.service.auditor.record(auditRecord({ kind: "browserNavigation", url: "https://example.test/1", pageTitle: "first write" }));
    value.service.auditor.record(auditRecord({ kind: "browserNavigation", url: "https://example.test/2", pageTitle: "second write" }));
    let disposeFinished = false;
    const disposing = value.service.dispose().then(() => { disposeFinished = true; });
    try {
      const didFirstStart = await Promise.race([
        firstStarted.then(() => true),
        new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => resolve(false), 250);
          void firstStarted.then(() => clearTimeout(timeout));
        }),
      ]);
      assert.equal(didFirstStart, true, "dispose must leave previously queued local writes running");
      assert.deepEqual(writeOrder, ["first write"]);
      releaseFirst();
      await secondStarted;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(disposeFinished, false, "shutdown waits for the last accepted append");
      releaseSecond();
      await disposing;
      assert.deepEqual(writeOrder, ["first write", "second write"]);
    } finally {
      releaseFirst();
      releaseSecond();
    }
  }, {
    appendLocalLine: async (_path, line) => {
      const pageTitle = (JSON.parse(line) as { pageTitle: string }).pageTitle;
      writeOrder.push(pageTitle);
      if (pageTitle === "first write") { startedFirst(); await holdFirst; }
      if (pageTitle === "second write") { startedSecond(); await holdSecond; }
    },
  });
});

test("dispose is idempotent, stops polling, drains pending rows, and closes local writes", async () => {
  await withWorld(async (value) => {
    value.service.auditor.record(auditRecord({ kind: "browserNavigation", url: "before", pageTitle: "Before" }));
    const first = value.service.dispose();
    const second = value.service.dispose();
    assert.equal(first, second);
    await first;
    assert.equal(value.poller.disposed(), 1);
    assert.equal(value.sent.flat().length, 1);
    assert.equal(value.localLines.length, 1);
    value.service.auditor.record(auditRecord({ kind: "browserNavigation", url: "after", pageTitle: "After" }));
    await value.service.flush();
    assert.equal(value.sent.flat().length, 1);
    assert.equal(value.localLines.length, 1);
  });
});
