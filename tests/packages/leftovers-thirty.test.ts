/**
 * The session entry, the browser and subagent reviews, the shell terminal watch, the daemon's production
 * executor, the run scheduler and the local-exec supervisor.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sessionExtension } from "../../source/host/extensions/session/extension.ts";
import { SLATE_BROWSER_AUTO_REVIEW_MAX_CDP_PARAMS_CHARS, SLATE_BROWSER_AUTO_REVIEW_MAX_ELEMENT_CHARS } from "../../source/host/runner/slate-browser-auto-review.ts";
import { SLATE_SUBAGENT_CLASSIFIER_ERROR_REASON, SLATE_SUBAGENT_CLASSIFIER_TARGET_ACTION } from "../../source/host/runner/slate-subagent-auto-review.ts";
import { collectPrependUserMessages, createShellWatchReadAccessor, SlateTerminalReadError } from "../../source/host/runner/shell-terminal-watch.ts";
import { assertProductionLocalExecRuntime, createDefaultProductionLocalExecExecutor, createProductionLocalExecExecutor, ProductionLocalExecCompositionError, PRODUCTION_LOCAL_EXEC_RUNTIME_BINDINGS } from "../../source/local-exec/production-executor.ts";
import { SlateRunScheduler, takeNextUserTask } from "../../source/host/transcript/run-scheduler.ts";
import { LOCAL_EXEC_DAEMON_DISCOVERY_MISS_LIMIT, LOCAL_EXEC_DAEMON_LIVENESS_INTERVAL_MS, LOCAL_EXEC_DAEMON_READINESS_POLL_MS } from "../../source/coordinator/local-exec/supervisor.ts";

describe("the session entry", () => {
  it("is an extension the host starts", () => {
    assert.equal(typeof sessionExtension, "object");
  });
});

describe("reviewing what an agent did in the browser", () => {
  it("bounds what it carries about an element and a call", () => {
    assert.equal(SLATE_BROWSER_AUTO_REVIEW_MAX_ELEMENT_CHARS, 500);
    assert.equal(SLATE_BROWSER_AUTO_REVIEW_MAX_CDP_PARAMS_CHARS, 2_000);
  });
});

describe("reviewing what a subagent did", () => {
  it("names the action it reviews and the reason a classifier failed", () => {
    assert.equal(SLATE_SUBAGENT_CLASSIFIER_TARGET_ACTION, "slate_subagent");
    assert.equal(SLATE_SUBAGENT_CLASSIFIER_ERROR_REASON.length > 0, true);
  });
});

describe("watching a shell terminal", () => {
  it("holds what arrived before a reader attached, and reports a terminal that ended", () => {
    assert.equal(typeof createShellWatchReadAccessor, "function");
    assert.equal(typeof collectPrependUserMessages, "function");
    assert.equal(new SlateTerminalReadError("gone").message, "gone");
  });
});

describe("the daemon's executor for a real machine", () => {
  it("brings the machine's execution together with nine bindings", () => {
    assert.equal(typeof createDefaultProductionLocalExecExecutor, "function");
    assert.equal(typeof createProductionLocalExecExecutor, "function");
    assert.equal(typeof assertProductionLocalExecRuntime, "function");
    assert.equal(PRODUCTION_LOCAL_EXEC_RUNTIME_BINDINGS.length, 9);
    // The error names the bindings that were missing.
    assert.match(new ProductionLocalExecCompositionError(["runtime.build"]).message, /runtime\.build/);
  });
});

describe("deciding when a run may start", () => {
  it("is one scheduler per host, and offers the next user task", () => {
    assert.equal(typeof SlateRunScheduler, "function");
    assert.equal(typeof takeNextUserTask, "function");
  });
});

describe("keeping the local-exec daemon alive", () => {
  it("checks liveness and readiness on its own intervals", () => {
    assert.equal(LOCAL_EXEC_DAEMON_LIVENESS_INTERVAL_MS, 1_000);
    assert.equal(LOCAL_EXEC_DAEMON_READINESS_POLL_MS, 50);
    assert.equal(LOCAL_EXEC_DAEMON_DISCOVERY_MISS_LIMIT, 2);
  });
});
