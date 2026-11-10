/**
 * Keeping a host process alive.
 *
 * The supervisor starts the host, watches it, and starts it again when it stops — with a bounded number of restarts in
 * a window and a backoff between them, so a host that cannot stay up is reported rather than restarted forever.
 */
import { createDeadlinePolicy, realClock, type Clock, type DeadlinePolicy } from "../../host/extensions/scheduling.ts";
import { classifyBaseUrlKind, classifyGatewayFetchFailure, outcomeForHttpStatus } from "./gateway-reachability.ts";

export const HEALTH_TIMEOUT_MS = 1_500;
export const HEALTH_PROBE_TTL_MS = 5_000;
export const DISABLE_HEALTH_TTL_ENV = "SLATE_DISABLE_GATEWAY_HEALTH_TTL";
export const DISABLE_STREAM_LIVENESS_ENV = "SLATE_DISABLE_GATEWAY_STREAM_LIVENESS";

export interface CoordinatorHostSupervisorTiming {
  clock: Clock;
  healthProbeDeadline: DeadlinePolicy;
}

export function createCoordinatorHostSupervisorTiming(): CoordinatorHostSupervisorTiming {
  return { clock: realClock, healthProbeDeadline: createDeadlinePolicy(realClock, { name: "gateway-health-probe", timeoutMs: HEALTH_TIMEOUT_MS }) };
}

export class GatewayConnectResolveAbandonedError extends Error {
  constructor() {
    super("the gateway connection resolve was abandoned before it answered");
    this.name = "GatewayConnectResolveAbandonedError";
  }
}

export interface GatewayConnection {
  baseUrl: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface HealthReachabilityReport {
  outcome: string;
  method: "health";
  latencyMs: number;
  baseUrlKind: "unknown" | "loopback" | "pod_proxy";
  httpStatus?: number;
  causeSummary?: string;
}

export async function fetchHealth(
  timing: CoordinatorHostSupervisorTiming,
  baseUrl: string,
  headers?: Record<string, string>,
  onReachability?: (publishReport: HealthReachabilityReport, baseUrl: string) => void
): Promise<Record<string, unknown> | null> {
  const probeStartedAt = timing.clock.monotonicNow();
  const publishReport = (reportValue: HealthReachabilityReport) => { try { onReachability?.(reportValue, baseUrl); } catch { /* best effort */ } };
  try {
    const probeResponse = await timing.healthProbeDeadline.run((signal) => fetch(`${baseUrl}/health`, { signal, ...(headers == null ? {} : { headers: { ...headers } }) }));
    if (!probeResponse.ok) {
      publishReport({ outcome: outcomeForHttpStatus(probeResponse.status) ?? "network", method: "health", latencyMs: timing.clock.monotonicNow() - probeStartedAt, baseUrlKind: classifyBaseUrlKind(baseUrl), httpStatus: probeResponse.status });
      return null;
    }
    const healthPayload = await probeResponse.json() as Record<string, unknown>;
    return healthPayload.ok === true ? healthPayload : null;
  } catch (failure) {
    const { outcome, causeSummary } = classifyGatewayFetchFailure(failure);
    publishReport({ outcome, method: "health", latencyMs: timing.clock.monotonicNow() - probeStartedAt, baseUrlKind: classifyBaseUrlKind(baseUrl), causeSummary });
    return null;
  }
}

interface ConnectionAttempt {
  epoch: number;
  resultPromise: Promise<GatewayConnection>;
  phase: "pending" | "settled";
  retired: boolean;
  waiterAttached: boolean;
  retirement: Promise<never>;
  abandon(): void;
}

export interface SlateHostSupervisorOptions {
  timing: CoordinatorHostSupervisorTiming;
  resolveGatewayConnection(): Promise<GatewayConnection>;
  isTransportLive?(): boolean;
  onReachability?(publishReport: HealthReachabilityReport, baseUrl: string): void;
}

export class SlateHostSupervisor {
  private gatewayConnection?: GatewayConnection;
  private lastHealthyAt = Number.NEGATIVE_INFINITY;
  private epoch = 0;
  private latestAttempt?: ConnectionAttempt;
  private readonly ttlDisabled: boolean;
  private readonly livenessDisabled: boolean;

  constructor(private readonly supervisorOptions: SlateHostSupervisorOptions) {
    this.ttlDisabled = process.env[DISABLE_HEALTH_TTL_ENV] === "1";
    this.livenessDisabled = process.env[DISABLE_STREAM_LIVENESS_ENV] === "1";
  }

  private startOrReuseAttempt(healthEpoch: number): ConnectionAttempt {
    const activeAttempt = this.latestAttempt;
    if (activeAttempt != null && activeAttempt.epoch === healthEpoch && activeAttempt.phase === "pending" && !activeAttempt.retired) return activeAttempt;
    let abandon = () => {};
    const retirement = new Promise<never>((_resolve, reject) => { abandon = () => reject(new GatewayConnectResolveAbandonedError()); });
    void retirement.catch(() => {});
    const connectAttempt: ConnectionAttempt = {
      epoch: healthEpoch,
      resultPromise: this.supervisorOptions.resolveGatewayConnection(),
      phase: "pending",
      retired: false,
      waiterAttached: false,
      retirement,
      abandon: () => { if (connectAttempt.retired) return; connectAttempt.retired = true; abandon(); }
    };
    this.latestAttempt = connectAttempt;
    const markAttemptSettled = () => { connectAttempt.phase = "settled"; };
    void connectAttempt.resultPromise.then(markAttemptSettled, markAttemptSettled);
    return connectAttempt;
  }

  private latestAttemptForEpoch(): ConnectionAttempt {
    const activeAttempt = this.latestAttempt;
    return activeAttempt != null && activeAttempt.epoch === this.epoch && !activeAttempt.retired ? activeAttempt : this.startOrReuseAttempt(this.epoch);
  }

  private async awaitConnectionAttempt(connectAttempt: ConnectionAttempt, signal?: AbortSignal): Promise<GatewayConnection> {
    if (signal == null) { connectAttempt.waiterAttached = true; return await Promise.race([connectAttempt.resultPromise, connectAttempt.retirement]); }
    if (signal.aborted) { if (!connectAttempt.waiterAttached) connectAttempt.abandon(); throw new GatewayConnectResolveAbandonedError(); }
    connectAttempt.waiterAttached = true;
    const onAbort = () => connectAttempt.abandon();
    signal.addEventListener("abort", onAbort, { once: true });
    try { return await Promise.race([connectAttempt.resultPromise, connectAttempt.retirement]); }
    finally { signal.removeEventListener("abort", onAbort); }
  }

  invalidateHealthCache(): void {
    this.epoch += 1;
    this.lastHealthyAt = Number.NEGATIVE_INFINITY;
    this.latestAttempt?.abandon();
  }

  async ensureConnection(signal?: AbortSignal): Promise<GatewayConnection> {
    const knownConnection = this.gatewayConnection;
    if (knownConnection != null) {
      if (!this.livenessDisabled && this.supervisorOptions.isTransportLive?.() === true) return knownConnection;
      if (!this.ttlDisabled && this.supervisorOptions.timing.clock.monotonicNow() - this.lastHealthyAt < HEALTH_PROBE_TTL_MS) return knownConnection;
      const probeEpoch = this.epoch;
      if (await fetchHealth(this.supervisorOptions.timing, knownConnection.baseUrl, knownConnection.headers, this.supervisorOptions.onReachability) != null) {
        if (probeEpoch === this.epoch) this.lastHealthyAt = this.supervisorOptions.timing.clock.monotonicNow();
        return knownConnection;
      }
    }
    const connectEpoch = this.epoch;
    let connectAttempt = this.startOrReuseAttempt(connectEpoch);
    for (;;) {
      try {
        const gatewayConnection = await this.awaitConnectionAttempt(connectAttempt, signal);
        const newerAttempt = this.latestAttempt;
        if (connectAttempt.epoch !== this.epoch) { connectAttempt = this.latestAttemptForEpoch(); continue; }
        if (newerAttempt !== connectAttempt) {
          if (newerAttempt == null) throw new Error("latest gateway connection attempt is missing");
          connectAttempt = newerAttempt;
          continue;
        }
        this.gatewayConnection = gatewayConnection;
        this.lastHealthyAt = Number.NEGATIVE_INFINITY;
        return gatewayConnection;
      } catch (failure) {
        const newerAttempt = this.latestAttempt;
        if (connectAttempt.epoch !== this.epoch) { connectAttempt = this.latestAttemptForEpoch(); continue; }
        if (newerAttempt === connectAttempt || newerAttempt == null) throw failure;
        connectAttempt = newerAttempt;
      }
    }
  }
}
