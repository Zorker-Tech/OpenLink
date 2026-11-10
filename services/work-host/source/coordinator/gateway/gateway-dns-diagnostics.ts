/**
 * Diagnosing why the gateway could not be reached.
 *
 * The address is resolved, each answer is tried in turn, and what is reported is what a caller needs to act on — which
 * name failed to resolve, which address refused — rather than a bare connection error.
 */
import { randomUUID } from "node:crypto";
import { Resolver, lookup } from "node:dns/promises";
import { DeadlineExceededError, createDeadlinePolicy, realClock, type Clock, type DeadlinePolicy } from "../../host/extensions/scheduling.ts";
import { findSystemErrno } from "../../shared/system-errno.ts";

export const DNS_PROBE_TIMEOUT_MS = 2_000;
export const DNS_PROBE_MIN_INTERVAL_MS = 60_000;
export const GENERAL_CONTROL_HOSTNAME = "api.slate.invalid";

export type DnsProbeResult = "resolved" | "timeout" | "not_found" | "temporary_failure" | "error";
export type DnsDiagnosis = "resolved_before_probe" | "system_path_failure" | "independent_path_failure" | "endpoint_failure" | "cursorvm_failure" | "general_dns_failure" | "inconclusive";

interface DnsTarget {
  endpointHostname: string;
  wildcardHostname: string;
  cluster: "dev4" | "us8";
}

export interface GatewayDnsDiagnostic {
  cluster: "dev4" | "us8";
  trigger: "not_found" | "temporary_failure" | "unknown";
  diagnosis: DnsDiagnosis;
  systemExact: DnsProbeResult;
  independentExact: DnsProbeResult;
  independentWildcard: DnsProbeResult;
  independentGeneral: DnsProbeResult;
}

function isAllowedCluster(value: string): value is DnsTarget["cluster"] {
  return value === "dev4" || value === "us8";
}

export function dnsTargetFromBaseUrl(endpointBaseUrl: string | null | undefined, makeWildcardLabel: () => string): DnsTarget | undefined {
  if (endpointBaseUrl == null) return undefined;
  try {
    const parsedUrl = new URL(endpointBaseUrl);
    const hostnameLabels = parsedUrl.hostname.split(".");
    if (parsedUrl.protocol !== "https:" || hostnameLabels.length !== 4 || hostnameLabels[0] == null || hostnameLabels[0].length === 0 || hostnameLabels[1] == null || hostnameLabels[2] !== "cursorvm" || hostnameLabels[3] !== "com" || !isAllowedCluster(hostnameLabels[1])) return undefined;
    const clusterLabel = hostnameLabels[1];
    const probeLabel = makeWildcardLabel();
    if (!/^[a-z0-9-]{1,63}$/.test(probeLabel)) return undefined;
    return { endpointHostname: parsedUrl.hostname, wildcardHostname: `${probeLabel}.${clusterLabel}.cursorvm.com`, cluster: clusterLabel };
  } catch {
    return undefined;
  }
}

export function classifyProbeError(failure: unknown): Exclude<DnsProbeResult, "resolved"> {
  if (failure instanceof DeadlineExceededError) return "timeout";
  switch (findSystemErrno(failure)) {
    case "ENOTFOUND":
    case "ENODATA":
      return "not_found";
    case "EAI_AGAIN":
    case "ESERVFAIL":
    case "EREFUSED":
      return "temporary_failure";
    case "ETIMEOUT":
    case "ETIMEDOUT":
      return "timeout";
    default:
      return "error";
  }
}

export function classifyDnsDiagnosis(probeResults: Omit<GatewayDnsDiagnostic, "cluster" | "trigger" | "diagnosis">): DnsDiagnosis {
  if (probeResults.systemExact === "resolved" && probeResults.independentExact === "resolved") return "resolved_before_probe";
  if (probeResults.systemExact !== "resolved" && probeResults.independentExact === "resolved") return "system_path_failure";
  if (probeResults.systemExact === "resolved" && probeResults.independentExact !== "resolved") return "independent_path_failure";
  if (probeResults.independentExact !== "resolved" && probeResults.independentWildcard === "resolved") return "endpoint_failure";
  if (probeResults.independentExact !== "resolved" && probeResults.independentWildcard !== "resolved" && probeResults.independentGeneral === "resolved") return "cursorvm_failure";
  if (probeResults.independentGeneral !== "resolved") return "general_dns_failure";
  return "inconclusive";
}

function triggerFromCause(failureSummary?: string): GatewayDnsDiagnostic["trigger"] {
  if (failureSummary?.includes("ENOTFOUND") === true) return "not_found";
  if (failureSummary?.includes("EAI_AGAIN") === true) return "temporary_failure";
  return "unknown";
}

export interface GatewayDnsDiagnosticReporterOptions {
  clock: Clock;
  deadline: DeadlinePolicy;
  systemLookup(lookupHostname: string): Promise<unknown>;
  independentLookup(lookupHostname: string): Promise<unknown>;
  createWildcardLabel(): string;
  onDiagnostic(dnsDiagnostic: GatewayDnsDiagnostic): void;
}

export class GatewayDnsDiagnosticReporter {
  private episodeActive = false;
  private probeInFlight = false;
  private lastProbeStartedAtMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: GatewayDnsDiagnosticReporterOptions) {}

  observe(dnsReport: { outcome: string; causeSummary?: string }, endpointBaseUrl?: string): void {
    if (dnsReport.outcome === "ok") {
      this.episodeActive = false;
      return;
    }
    if (dnsReport.outcome !== "dns" || this.episodeActive) return;
    const dnsTarget = dnsTargetFromBaseUrl(endpointBaseUrl, this.options.createWildcardLabel);
    if (dnsTarget == null) return;
    const observedAtMs = this.options.clock.monotonicNow();
    if (this.probeInFlight || observedAtMs - this.lastProbeStartedAtMs < DNS_PROBE_MIN_INTERVAL_MS) return;
    this.episodeActive = true;
    this.probeInFlight = true;
    this.lastProbeStartedAtMs = observedAtMs;
    void this.run(dnsTarget, triggerFromCause(dnsReport.causeSummary)).then(
      (dnsDiagnostic) => {
        this.probeInFlight = false;
        try { this.options.onDiagnostic(dnsDiagnostic); } catch { return; }
      },
      () => { this.probeInFlight = false; }
    );
  }

  private async run(dnsTarget: DnsTarget, trigger: GatewayDnsDiagnostic["trigger"]): Promise<GatewayDnsDiagnostic> {
    const runProbe = async (lookupCall: () => Promise<unknown>): Promise<DnsProbeResult> => {
      try {
        await this.options.deadline.run(() => lookupCall());
        return "resolved";
      } catch (failure) {
        return classifyProbeError(failure);
      }
    };
    const [systemExact, independentExact, independentWildcard, independentGeneral] = await Promise.all([
      runProbe(() => this.options.systemLookup(dnsTarget.endpointHostname)),
      runProbe(() => this.options.independentLookup(dnsTarget.endpointHostname)),
      runProbe(() => this.options.independentLookup(dnsTarget.wildcardHostname)),
      runProbe(() => this.options.independentLookup(GENERAL_CONTROL_HOSTNAME))
    ]);
    const probeResults = { systemExact, independentExact, independentWildcard, independentGeneral };
    return { cluster: dnsTarget.cluster, trigger, diagnosis: classifyDnsDiagnosis(probeResults), ...probeResults };
  }
}

export function createGatewayDnsDiagnosticReporter(reportDiagnostic: (dnsDiagnostic: GatewayDnsDiagnostic) => void): GatewayDnsDiagnosticReporter {
  const independentResolver = new Resolver({ timeout: DNS_PROBE_TIMEOUT_MS, tries: 1 });
  return new GatewayDnsDiagnosticReporter({
    clock: realClock,
    deadline: createDeadlinePolicy(realClock, { name: "gateway-dns-diagnostic", timeoutMs: DNS_PROBE_TIMEOUT_MS }),
    systemLookup: (lookupHostname) => lookup(lookupHostname),
    independentLookup: (lookupHostname) => independentResolver.resolve4(lookupHostname),
    createWildcardLabel: () => `slate-dns-probe-${randomUUID()}`,
    onDiagnostic: reportDiagnostic
  });
}
