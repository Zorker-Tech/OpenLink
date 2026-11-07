import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  IGNORED_URL_PREFIXES,
  NAVIGATION_PROBE_CDP_BASE_PORT,
  NAVIGATION_PROBE_MIN_INTERVAL_MS,
  computerUseAuditKind,
  createSlateNavigationProbe,
  mcpAuditStatus,
  navigationProbeCommand,
  normalizeNavigationUrl,
  parseNavigationProbeOutput,
  wrapMcpExecutorForAudit,
} from "../../source/host/runner/slate-action-audit.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("auditing what an agent did", () => {
  it("decides whether an MCP answer is a success", () => {
    assert.equal(mcpAuditStatus({ result: { case: "success", value: { isError: false } } }), "ok");
    assert.equal(mcpAuditStatus({ result: { case: "success", value: { isError: true } } }), "error");
    assert.equal(mcpAuditStatus({ result: { case: "approved", value: {} } }), "ok");
    assert.equal(mcpAuditStatus({ result: { case: "rejected", value: {} } }), "error");
    assert.equal(mcpAuditStatus({ result: { case: undefined, value: undefined } }), "error");
  });

  it("records an MCP call with what it was, how it went and how long it took", async () => {
    const records: any[] = [];
    const times = [10, 25];
    let index = 0;
    const wrapped = wrapMcpExecutorForAudit(
      { execute: async () => ({ result: { case: "success", value: { isError: false } } }) },
      {
        agentId: "agent-1",
        auditor: { record: (entry: any) => { records.push(entry); return Promise.resolve(); } } as never,
        resolveTransport: async (server) => "transport:" + server,
        getTurnId: () => "turn-1",
        now: () => times[Math.min(index++, times.length - 1)] as number,
      },
    );
    const result = await wrapped.execute("CTX" as never, { providerIdentifier: "server-1", toolCallId: "call-1", name: "tool-1" } as never, {});
    assert.deepEqual(result, { result: { case: "success", value: { isError: false } } });
    await settle(); await settle();
    assert.deepEqual(records, [{
      agentId: "agent-1",
      turnId: "turn-1",
      occurredAtMs: 10,
      action: { kind: "mcpToolCall", toolCallId: "call-1", serverIdentifier: "server-1", serverName: "server-1", toolName: "tool-1", transport: "transport:server-1", status: "ok", durationMs: 15 },
    }]);
  });

  it("records a failed call, and a transport it could not resolve", async () => {
    const records: any[] = [];
    const failing = wrapMcpExecutorForAudit(
      { execute: async () => { throw new Error("tool failed"); } },
      { agentId: "agent-1", auditor: { record: (entry: any) => { records.push(entry); return Promise.resolve(); } } as never, resolveTransport: async () => { throw new Error("no transport"); }, now: () => 5 },
    );
    await assert.rejects(async () => await failing.execute("CTX" as never, { providerIdentifier: "s", name: "t" } as never), { message: "tool failed" });
    await settle(); await settle();
    assert.deepEqual(records.map((entry) => [entry.action.status, entry.action.transport, entry.action.toolCallId]), [["error", "unknown", ""]]);
    assert.equal("turnId" in records[0], false, "a call outside a turn has no turn id");
    // An answer that reports its own error is a failed call, not a successful one.
    const errored: any[] = [];
    const wrappedError = wrapMcpExecutorForAudit(
      { execute: async () => ({ result: { case: "success", value: { isError: true } } }) },
      { agentId: "agent-1", auditor: { record: (entry: any) => { errored.push(entry); return Promise.resolve(); } } as never, resolveTransport: async () => "t", now: () => 5 },
    );
    await wrappedError.execute("CTX" as never, { providerIdentifier: "s", name: "t" } as never);
    await settle(); await settle();
    assert.equal(errored[0].action.status, "error");
  });

  it("builds the navigation probe command and normalizes URLs", () => {
    assert.equal(NAVIGATION_PROBE_CDP_BASE_PORT, 9_222);
    assert.equal(NAVIGATION_PROBE_MIN_INTERVAL_MS, 2_000);
    assert.deepEqual(IGNORED_URL_PREFIXES, ["about:", "chrome://", "chrome-extension://", "chrome-untrusted://", "devtools://"]);
    assert.equal(navigationProbeCommand(1), "curl -sf --max-time 2 \"http://127.0.0.1:9223/json/list\"");
    assert.equal(normalizeNavigationUrl(" https://example.com/a?q=1 "), "https://example.com/a");
    assert.equal(normalizeNavigationUrl("HTTPS://EXAMPLE.COM/A"), "https://example.com/A");
    assert.equal(normalizeNavigationUrl("about:blank"), undefined);
    assert.equal(normalizeNavigationUrl("chrome://version"), undefined);
    assert.equal(normalizeNavigationUrl("data:text/html,x"), undefined, "an opaque origin is not a page");
    assert.equal(normalizeNavigationUrl("not a url"), undefined);
    assert.equal(normalizeNavigationUrl("   "), undefined);
  });

  it("finds the JSON arrays a probe answer carries", () => {
    assert.deepEqual(parseNavigationProbeOutput("[]"), []);
    assert.deepEqual(parseNavigationProbeOutput("junk [{\"id\":\"p1\"}] junk [{\"id\":\"p2\"}]"), [{ id: "p1" }, { id: "p2" }]);
    assert.deepEqual(parseNavigationProbeOutput("[{\"title\":\"a]b\"}]"), [{ title: "a]b" }]);
    assert.deepEqual(parseNavigationProbeOutput("[{\"title\":\"quote \\\" inside\"}]"), [{ title: "quote \" inside" }]);
    assert.deepEqual(parseNavigationProbeOutput("[not json]"), []);
    assert.deepEqual(parseNavigationProbeOutput("{\"id\":\"p1\"}"), []);
  });

  it("reports the pages a probe found, once per URL", async () => {
    const records: any[] = [];
    const probe = createSlateNavigationProbe({
      agentId: "agent-1",
      auditor: { record: (entry: any) => { records.push(entry); return Promise.resolve(); } } as never,
      now: () => 10_000,
      getBoxId: () => "box-1",
      getTurnId: () => "turn-9",
    });
    const accessor = {
      get: () => ({
        execute: async () => ({
          result: { case: "success", value: { exitCode: 0, stdout: "[{\"id\":\"p1\",\"type\":\"page\",\"url\":\"https://a.com/one\",\"title\":\"One\"},{\"id\":\"p1\",\"type\":\"page\",\"url\":\"https://a.com/one\"},{\"id\":\"p2\",\"type\":\"service-worker\",\"url\":\"https://a.com/two\"},{\"id\":\"\",\"type\":\"page\",\"url\":\"https://a.com/three\"}]" } } }),
      }),
    };
    probe.probe("CTX" as never, accessor, 1);
    await settle(); await settle();
    assert.deepEqual(records, [{
      agentId: "agent-1",
      turnId: "turn-9",
      boxId: "box-1",
      occurredAtMs: 10_000,
      action: { kind: "browserNavigation", url: "https://a.com/one", pageTitle: "One" },
    }]);
    // A failing probe records nothing.
    const failing = createSlateNavigationProbe({ agentId: "agent-1", auditor: { record: (entry: any) => { records.push(entry); return Promise.resolve(); } } as never, now: () => 20_000 });
    failing.probe("CTX" as never, { get: () => ({ execute: async () => ({ result: { case: "success", value: { exitCode: 1, stdout: "" } } }) }) }, 1);
    await settle(); await settle();
    assert.equal(records.length, 1);
  });

  it("captures a baseline without reporting it, then runs the probe it queued", async () => {
    const records: any[] = [];
    const probe = createSlateNavigationProbe({
      agentId: "agent-1",
      auditor: { record: (entry: any) => { records.push(entry); return Promise.resolve(); } } as never,
      now: () => 5_000,
    });
    const baselineAccessor = { get: () => ({ execute: async () => ({ result: { case: "success", value: { exitCode: 0, stdout: "[{\"id\":\"p1\",\"type\":\"page\",\"url\":\"https://a.com/one\"}]" } } }) }) };
    const accessor = { get: () => ({ execute: async () => ({ result: { case: "success", value: { exitCode: 0, stdout: "[{\"id\":\"p1\",\"type\":\"page\",\"url\":\"https://a.com/two\"}]" } } }) }) };
    const baseline = probe.captureBaseline("CTX" as never, baselineAccessor, 1);
    assert.equal(probe.captureBaseline("CTX" as never, baselineAccessor, 1), baseline, "one baseline per probe");
    probe.probe("CTX" as never, accessor, 1);
    await baseline;
    await settle(); await settle();
    assert.equal(records.length, 1, "the baseline itself is not reported, the queued probe is");
    assert.equal(records[0].action.url, "https://a.com/two");
  });

  it("names the audit kind of every computer-use action", () => {
    assert.deepEqual(
      ["screenshot", "click", "mouse-move", "mouse-down", "mouse-up", "drag", "type", "key", "scroll", "wait", "cursor-position"].map(computerUseAuditKind),
      ["screenshot", "click", "mouse_move", "mouse_down", "mouse_up", "drag", "type", "key", "scroll", "wait", "cursor_position"],
    );
    for (const actionCase of ["other", "mouseMove", "toString", "__proto__", "constructor", ""]) assert.equal(computerUseAuditKind(actionCase), undefined, actionCase);
  });
});
