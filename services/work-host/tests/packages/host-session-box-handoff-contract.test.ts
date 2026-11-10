import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BoxHandoffService,
  MAX_DOMAIN_LENGTH,
  SNAPSHOT_TIMEOUT_MS,
  decideBoxHandBack,
  type BoxHandoffDeps,
  type HandoffRequest,
} from "../../source/host/extensions/session/box-handoff-service.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function harness(overrides: Partial<BoxHandoffDeps> = {}) {
  const started: Array<{ agentId: string; instruction: string }> = [];
  const ended: Array<{ agentId: string; requestId: string; resolution: string; trigger: string }> = [];
  const statusChanged: string[] = [];
  const helpReports: Array<Record<string, unknown>> = [];
  const events: Array<{ name: string; properties: Record<string, unknown> }> = [];
  const reports: Array<Record<string, unknown>> = [];
  const reported = deferred<Record<string, unknown>>();
  const deps: BoxHandoffDeps = {
    grabScreenshot: async () => null,
    ...overrides,
    onStarted: (event) => { started.push(event); overrides.onStarted?.(event); },
    onEnded: (event) => { ended.push(event); return overrides.onEnded?.(event); },
    onStatusChanged: (agentId) => { statusChanged.push(agentId); overrides.onStatusChanged?.(agentId); },
    telemetry: {
      reportBoxHelp: (event) => { helpReports.push(event); overrides.telemetry?.reportBoxHelp(event); },
      trackEvent: (name, properties) => { events.push({ name, properties }); overrides.telemetry?.trackEvent(name, properties); },
    },
    report: (event) => { reports.push(event); reported.resolve(event); overrides.report?.(event); },
  };
  return { service: new BoxHandoffService(deps), started, ended, statusChanged, helpReports, events, reports, reported };
}

const request = (agentId = "agent-1", telemetry?: HandoffRequest["telemetry"]): HandoffRequest => ({
  agentId,
  instruction: "Continue after the user signs in.",
  ...(telemetry === undefined ? {} : { telemetry }),
});

describe("box handoff behavior contract", () => {
  it("starts once per agent and returns the existing handoff on a duplicate request", () => {
    const screenshot = deferred<string | null>();
    const h = harness({ grabScreenshot: () => screenshot.promise });

    assert.equal(h.service.get("agent-1"), null);
    const first = h.service.start(request());
    assert.equal(first.kind, "started");
    if (first.kind !== "started") return;
    assert.match(first.requestId, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(h.service.get("agent-1"), { requestId: first.requestId, instruction: request().instruction });

    const duplicate = h.service.start({ ...request(), instruction: "A later instruction must not replace the active one." });
    assert.deepEqual(duplicate, { kind: "already-pending", requestId: first.requestId, instruction: request().instruction });
    assert.deepEqual(h.started, [{ agentId: "agent-1", instruction: request().instruction }]);
    assert.deepEqual(h.statusChanged, ["agent-1"]);
    screenshot.resolve(null);
  });

  it("stores a non-empty string snapshot and reports a bounded, normalized event", async () => {
    const screenshot = deferred<string | null>();
    const domain = "d".repeat(MAX_DOMAIN_LENGTH + 8);
    const idpDomain = "i".repeat(MAX_DOMAIN_LENGTH + 6);
    const h = harness({ grabScreenshot: () => screenshot.promise });
    const started = h.service.start(request("agent-2", { reason: "captcha", domain, idpDomain }));
    assert.equal(started.kind, "started");
    screenshot.resolve("aGVsbG8=");

    assert.deepEqual(await h.reported.promise, { outcome: "ready", agentId: "agent-2" });
    assert.deepEqual(h.service.get("agent-2"), {
      requestId: started.kind === "started" ? started.requestId : "",
      instruction: request().instruction,
      snapshotDataUrl: "data:image/webp;base64,aGVsbG8=",
    });
    assert.deepEqual(h.statusChanged, ["agent-2", "agent-2"]);
    assert.deepEqual(h.helpReports, [{ conversationId: "agent-2", snapshotCaptured: true, reason: "captcha" }]);
    assert.deepEqual(h.events, [{
      name: "slate.box_help",
      properties: {
        agent_id: "agent-2",
        snapshot_captured: true,
        reason: "captcha",
        domain: domain.slice(0, MAX_DOMAIN_LENGTH),
        idp_domain: idpDomain.slice(0, MAX_DOMAIN_LENGTH),
      },
    }]);
  });

  it("encodes byte snapshots as base64 before storing them", async () => {
    const h = harness({ grabScreenshot: async () => new Uint8Array([1, 2, 3]) });
    h.service.start(request("agent-bytes"));

    await h.reported.promise;
    assert.equal(h.service.get("agent-bytes")?.snapshotDataUrl, "data:image/webp;base64,AQID");
  });

  it("ends and clears a handoff once, mapping cancel and object triggers", async () => {
    const h = harness();
    const first = h.service.start(request("agent-cancel"));
    assert.equal(first.kind, "started");
    await h.service.end("agent-cancel", "cancel");
    await h.service.end("agent-cancel", "cancel");
    assert.equal(h.service.get("agent-cancel"), null);
    assert.deepEqual(h.ended, first.kind === "started" ? [{ agentId: "agent-cancel", requestId: first.requestId, resolution: "cancelled", trigger: "cancel" }] : []);
    assert.deepEqual(h.statusChanged, ["agent-cancel", "agent-cancel"]);

    const other = harness();
    const second = other.service.start(request("agent-object"));
    assert.equal(second.kind, "started");
    await other.service.end("agent-object", { resolution: "cancelled", trigger: "close-button" });
    assert.deepEqual(other.ended, second.kind === "started" ? [{ agentId: "agent-object", requestId: second.requestId, resolution: "cancelled", trigger: "close-button" }] : []);
  });

  it("does not dispatch a second end while the first end callback is pending", async () => {
    const finish = deferred<void>();
    const h = harness({ onEnded: () => finish.promise });
    h.service.start(request("agent-race"));
    const first = h.service.end("agent-race", "done");
    const second = h.service.end("agent-race", "done");

    assert.equal(h.ended.length, 1);
    assert.equal(h.service.get("agent-race"), null);
    finish.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(h.statusChanged, ["agent-race", "agent-race"]);
  });

  it("does not attach a screenshot that finishes after end", async () => {
    const screenshot = deferred<string | null>();
    const h = harness({ grabScreenshot: () => screenshot.promise });
    const started = h.service.start(request("agent-ended-first"));
    await h.service.end("agent-ended-first", "done");
    screenshot.resolve("late-image");

    await h.reported.promise;
    assert.equal(h.service.get("agent-ended-first"), null);
    assert.equal(h.helpReports[0]?.snapshotCaptured, false);
    assert.deepEqual(h.reports, [{ outcome: "no_snapshot", agentId: "agent-ended-first" }]);
    assert.equal(started.kind, "started");
  });

  it("does not resurrect a forgotten handoff when its screenshot finishes", async () => {
    const screenshot = deferred<Uint8Array | null>();
    const h = harness({ grabScreenshot: () => screenshot.promise });
    h.service.start(request("agent-forgotten"));
    h.service.forget("agent-forgotten");
    screenshot.resolve(new Uint8Array([9]));

    await h.reported.promise;
    assert.equal(h.service.get("agent-forgotten"), null);
    assert.equal(h.helpReports[0]?.snapshotCaptured, false);
  });

  it("reports prepare failures and unknown telemetry reasons without failing the handoff", async () => {
    let screenshotCalls = 0;
    const h = harness({
      prepare: async () => { throw new Error("prepare unavailable"); },
      grabScreenshot: async () => { screenshotCalls += 1; return "unused"; },
    });
    const started = h.service.start(request("agent-prepare-error", { reason: "mfa", domain: "example.test" }));
    assert.equal(started.kind, "started");

    await h.reported.promise;
    assert.equal(h.service.get("agent-prepare-error")?.requestId, started.kind === "started" ? started.requestId : undefined);
    assert.equal(screenshotCalls, 0);
    assert.deepEqual(h.helpReports, [{ conversationId: "agent-prepare-error", snapshotCaptured: false, reason: "mfa" }]);
    assert.deepEqual(h.events, [{ name: "slate.box_help", properties: {
      agent_id: "agent-prepare-error", snapshot_captured: false, reason: "other", domain: "example.test",
    } }]);
    assert.deepEqual(h.reports, [{ outcome: "no_snapshot", agentId: "agent-prepare-error" }]);
  });

  it("reports a synchronous screenshot-provider failure as an absent snapshot", async () => {
    const h = harness({ grabScreenshot: () => { throw new Error("capture unavailable"); } });
    h.service.start(request("agent-capture-error"));

    await h.reported.promise;
    assert.equal(h.service.get("agent-capture-error")?.snapshotDataUrl, undefined);
    assert.deepEqual(h.reports, [{ outcome: "no_snapshot", agentId: "agent-capture-error" }]);
  });

  it("times out screenshot capture and omits an absent telemetry reason", async () => {
    const h = harness({ grabScreenshot: () => new Promise<string | null>(() => {}), timeoutMs: 5 });
    h.service.start(request("agent-timeout"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(h.reports.length, 1);
    assert.deepEqual(h.reports[0], { outcome: "no_snapshot", agentId: "agent-timeout" });
    assert.deepEqual(h.events, [{ name: "slate.box_help", properties: { agent_id: "agent-timeout", snapshot_captured: false } }]);
    assert.equal(SNAPSHOT_TIMEOUT_MS, 5_000);
  });

  it("maps missing and explicit triggers without inventing an end for absent state", () => {
    const pending = { requestId: "r1", instruction: "continue" };
    assert.deepEqual(decideBoxHandBack(undefined, "done"), { kind: "none" });
    assert.deepEqual(decideBoxHandBack(pending, "cancel"), { kind: "end", requestId: "r1", resolution: "cancelled", trigger: "cancel" });
    assert.deepEqual(decideBoxHandBack(pending, "finished"), { kind: "end", requestId: "r1", resolution: "completed", trigger: "finished" });
    assert.deepEqual(decideBoxHandBack(pending, {}), { kind: "end", requestId: "r1", resolution: "completed", trigger: "unknown" });
  });
});
