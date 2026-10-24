import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DNS_PROBE_MIN_INTERVAL_MS,
  GatewayDnsDiagnosticReporter,
  classifyDnsDiagnosis,
  classifyProbeError,
  dnsTargetFromBaseUrl,
} from "../../source/coordinator/gateway/gateway-dns-diagnostics.ts";
import { DeadlineExceededError } from "../../source/host/extensions/scheduling.ts";

const errno = (code: string) => Object.assign(new Error(code), { code });
const ok = { outcome: "ok" };
const dns = (causeSummary?: string) => causeSummary === undefined ? { outcome: "dns" } : { outcome: "dns", causeSummary };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const validUrl = "https://endpoint.dev4.cursorvm.com";
const label = () => "probe-label";

describe("reading a DNS target from the gateway address", () => {
  it("accepts an https endpoint on an allowed cluster and builds the wildcard name", () => {
    assert.deepEqual(dnsTargetFromBaseUrl(validUrl, label), {
      endpointHostname: "endpoint.dev4.cursorvm.com",
      wildcardHostname: "probe-label.dev4.cursorvm.com",
      cluster: "dev4",
    });
    assert.deepEqual(dnsTargetFromBaseUrl("https://x.us8.cursorvm.com", label), {
      endpointHostname: "x.us8.cursorvm.com",
      wildcardHostname: "probe-label.us8.cursorvm.com",
      cluster: "us8",
    });
  });

  it("refuses addresses that are not the gateway shape", () => {
    assert.equal(dnsTargetFromBaseUrl(null, label), undefined);
    assert.equal(dnsTargetFromBaseUrl(undefined, label), undefined);
    assert.equal(dnsTargetFromBaseUrl("http://endpoint.dev4.cursorvm.com", label), undefined);
    assert.equal(dnsTargetFromBaseUrl("https://endpoint.us9.cursorvm.com", label), undefined);
    assert.equal(dnsTargetFromBaseUrl("https://endpoint.dev4.cursorvm.net", label), undefined);
    assert.equal(dnsTargetFromBaseUrl("https://a.b.cursorvm.com", label), undefined);
    assert.equal(dnsTargetFromBaseUrl("not a url", label), undefined);
    assert.equal(dnsTargetFromBaseUrl(validUrl, () => "BAD_LABEL"), undefined);
    assert.equal(dnsTargetFromBaseUrl(validUrl, () => ""), undefined);
    assert.equal(dnsTargetFromBaseUrl(validUrl, () => "a".repeat(64)), undefined);
  });
});

describe("classifying DNS failures", () => {
  it("maps deadlines and errnos to a probe result", () => {
    assert.equal(classifyProbeError(new DeadlineExceededError("dns")), "timeout");
    assert.equal(classifyProbeError(errno("ENOTFOUND")), "not_found");
    assert.equal(classifyProbeError(errno("ENODATA")), "not_found");
    assert.equal(classifyProbeError(errno("EAI_AGAIN")), "temporary_failure");
    assert.equal(classifyProbeError(errno("ESERVFAIL")), "temporary_failure");
    assert.equal(classifyProbeError(errno("EREFUSED")), "temporary_failure");
    assert.equal(classifyProbeError(errno("ETIMEOUT")), "timeout");
    assert.equal(classifyProbeError(errno("ETIMEDOUT")), "timeout");
    assert.equal(classifyProbeError(errno("ECONNREFUSED")), "error");
    assert.equal(classifyProbeError(new Error("plain")), "error");
    assert.equal(classifyProbeError(Object.assign(new Error("outer"), { cause: errno("ENOTFOUND") })), "not_found");
  });

  it("decides the diagnosis from the four probe results", () => {
    const cases: Array<[string, string, string, string, string]> = [
      ["resolved", "resolved", "resolved", "resolved", "resolved_before_probe"],
      ["not_found", "resolved", "resolved", "resolved", "system_path_failure"],
      ["resolved", "not_found", "resolved", "resolved", "independent_path_failure"],
      ["not_found", "not_found", "resolved", "resolved", "endpoint_failure"],
      ["not_found", "not_found", "not_found", "resolved", "cursorvm_failure"],
      ["not_found", "not_found", "not_found", "not_found", "general_dns_failure"],
      ["resolved", "resolved", "not_found", "not_found", "resolved_before_probe"],
    ];
    for (const [systemExact, independentExact, independentWildcard, independentGeneral, expected] of cases) {
      assert.equal(
        classifyDnsDiagnosis({ systemExact, independentExact, independentWildcard, independentGeneral } as never),
        expected,
        `${systemExact}/${independentExact}/${independentWildcard}/${independentGeneral}`,
      );
    }
  });
});

function reporter(options: {
  systemLookup?: (hostname: string) => Promise<unknown>;
  independentLookup?: (hostname: string) => Promise<unknown>;
  onDiagnostic?: (diagnostic: unknown) => void;
  now?: () => number;
}) {
  const diagnostics: unknown[] = [];
  const instance = new GatewayDnsDiagnosticReporter({
    clock: { monotonicNow: options.now ?? (() => 0) } as never,
    deadline: { name: "dns", run: async (work: () => Promise<unknown>) => work() } as never,
    systemLookup: options.systemLookup ?? (async () => undefined),
    independentLookup: options.independentLookup ?? (async () => undefined),
    createWildcardLabel: label,
    onDiagnostic: options.onDiagnostic ?? ((diagnostic) => diagnostics.push(diagnostic)),
  });
  return { instance, diagnostics };
}

describe("reporting DNS diagnostics", () => {
  it("probes once per episode and reports the diagnosis", async () => {
    let now = 0;
    let probes = 0;
    const world = reporter({ now: () => now, systemLookup: async () => { probes += 1; return ["127.0.0.1"]; }, independentLookup: async () => { probes += 1; return ["127.0.0.1"]; } });
    world.instance.observe(dns("boom ENOTFOUND"), validUrl);
    await tick();
    assert.equal(world.diagnostics.length, 1);
    assert.equal(probes, 4);
    const diagnostic = world.diagnostics[0] as Record<string, unknown>;
    assert.equal(diagnostic.cluster, "dev4");
    assert.equal(diagnostic.trigger, "not_found");
    assert.equal(diagnostic.diagnosis, "resolved_before_probe");

    world.instance.observe(dns("boom"), validUrl);
    await tick();
    assert.equal(world.diagnostics.length, 1);
    world.instance.observe(ok, validUrl);
    now = DNS_PROBE_MIN_INTERVAL_MS;
    world.instance.observe(dns("boom EAI_AGAIN"), validUrl);
    await tick();
    assert.equal(world.diagnostics.length, 2);
    assert.equal((world.diagnostics[1] as Record<string, unknown>).trigger, "temporary_failure");
  });

  it("ignores other outcomes, missing targets and probes that are already running", async () => {
    const world = reporter({});
    world.instance.observe({ outcome: "timeout" }, validUrl);
    world.instance.observe(dns(), null as never);
    await tick();
    assert.equal(world.diagnostics.length, 0);

    let release: (() => void) | undefined;
    const gate = new Promise<unknown>((resolve) => { release = () => resolve([]); });
    const running = reporter({ systemLookup: () => gate, independentLookup: () => gate });
    running.instance.observe(dns(), validUrl);
    running.instance.observe(dns(), validUrl);
    release?.();
    await tick();
    assert.equal(running.diagnostics.length, 1);
  });

  it("does not start a probe while one is still in flight, even after a success", async () => {
    let now = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<unknown>((resolve) => { release = () => resolve([]); });
    const world = reporter({ now: () => now, systemLookup: () => gate, independentLookup: () => gate });
    world.instance.observe(dns(), validUrl);
    world.instance.observe(ok, validUrl);
    now = DNS_PROBE_MIN_INTERVAL_MS;
    world.instance.observe(dns(), validUrl);
    release?.();
    await tick();
    assert.equal(world.diagnostics.length, 1);
  });

  it("respects the minimum interval between probes", async () => {
    let now = 0;
    const world = reporter({ now: () => now });
    world.instance.observe(dns(), validUrl);
    await tick();
    assert.equal(world.diagnostics.length, 1);
    world.instance.observe(ok, validUrl);
    world.instance.observe(dns(), validUrl);
    await tick();
    assert.equal(world.diagnostics.length, 1);
    now = DNS_PROBE_MIN_INTERVAL_MS;
    world.instance.observe(dns(), validUrl);
    await tick();
    assert.equal(world.diagnostics.length, 2);
  });

  it("classifies each lookup failure into the report", async () => {
    const world = reporter({
      systemLookup: async () => { throw errno("ENOTFOUND"); },
      independentLookup: async () => ["127.0.0.1"],
    });
    world.instance.observe(dns("ENOTFOUND"), validUrl);
    await tick();
    const diagnostic = world.diagnostics[0] as Record<string, unknown>;
    assert.equal(diagnostic.systemExact, "not_found");
    assert.equal(diagnostic.independentExact, "resolved");
    assert.equal(diagnostic.diagnosis, "system_path_failure");
  });

  it("keeps probing after a reporter that throws", async () => {
    let now = 0;
    let calls = 0;
    const world = reporter({ now: () => now, onDiagnostic: () => { calls += 1; throw new Error("reporter failed"); } });
    world.instance.observe(dns(), validUrl);
    await tick();
    world.instance.observe(ok, validUrl);
    now = DNS_PROBE_MIN_INTERVAL_MS;
    world.instance.observe(dns(), validUrl);
    await tick();
    assert.equal(calls, 2);
  });
});
