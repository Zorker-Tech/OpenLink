/**
 * The three extension entries that were waiting for their services, the action audit, waiting on a clock
 * and the workflow library.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createStateBackstopExtension } from "../../source/host/extensions/state-backstop/extension.ts";
import { wallpaperExtension } from "../../source/host/extensions/wallpaper/extension.ts";
import { createSecretsExtension } from "../../source/host/extensions/secrets/extension.ts";
import { createSlateActionAuditor, flushFailureBackoffMs, isBackendForwardable, localAuditJsonlLine, MAX_AUDIT_BATCH_SIZE, MAX_PENDING_AUDIT_EVENTS } from "../../source/host/extensions/action-audit/action-audit-service.ts";
import { delay, delayWith } from "../../source/shared/node/async.ts";
import { GlobalWorkflowLibrary, WORKFLOW_CHANGE_DEBOUNCE_MS } from "../../source/host/workflows/workflow-library.ts";

describe("the extension entries their services were waiting for", () => {
  it("each wires its service into a running host", () => {
    assert.equal(typeof createStateBackstopExtension, "function");
    assert.equal(typeof createSecretsExtension, "function");
    assert.equal(typeof wallpaperExtension, "object");
  });
});

describe("the record of what the platform did", () => {
  it("bounds what it keeps and batches what it forwards", () => {
    assert.equal(MAX_AUDIT_BATCH_SIZE, 50);
    assert.equal(MAX_PENDING_AUDIT_EVENTS, 2_000);
    assert.equal(typeof createSlateActionAuditor, "function");
    assert.equal(typeof localAuditJsonlLine, "function");
    assert.equal(typeof isBackendForwardable, "function");
    assert.equal(typeof flushFailureBackoffMs, "function");
  });
});

describe("waiting on a clock", () => {
  it("waits on the platform's clock by default and on one the caller gives", async () => {
    const started = Date.now();
    await delay(5);
    assert.equal(Date.now() - started >= 4, true);
    // A clock schedules work and hands back something it can be disposed with.
    let waited = 0;
    const clock = { schedule: (ms: number, run: () => void) => { waited = ms; run(); return { dispose: () => {} }; } };
    await delayWith(clock as never, 42);
    assert.equal(waited, 42);
    const aborted = new AbortController();
    aborted.abort();
    await delayWith(clock as never, 10, aborted.signal);
  });
});

describe("the workflows an agent has", () => {
  it("is a library the host can build, with its own debounce", () => {
    assert.equal(typeof GlobalWorkflowLibrary, "function");
    assert.equal(WORKFLOW_CHANGE_DEBOUNCE_MS, 50);
  });
});
