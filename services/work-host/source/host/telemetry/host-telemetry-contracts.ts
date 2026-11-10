import type { DeadlinePolicy, ExpiryPolicy, PollingPolicy } from "../extensions/scheduling.ts"
import type { StructuredLogClient } from "../../shared/observability/structured-log-transport.ts"
import type { Metadata } from "./structured-log-telemetry.ts"
import type { AnalyticsClient } from "./analytics-service.ts"
import type { HostCrashMarkerStore } from "./host-crash-marker.ts"
import type { HostTracing } from "./host-tracing.ts"
import type { BoxLogShipper } from "./box-log-shipper.ts"
import type { ProductAnalyticsClient, ProductAnalyticsGate } from "../../shared/node/analytics/product-analytics.ts"

export interface BoxLogShipping {
  start(): Promise<void>
  stopPolling(): Promise<void>
  checkpointOffsets(): Promise<void>
  dispose(): Promise<void>
}

export type CredentialRenewal = {
  outcome: string
  consecutiveFailures: number
  durationMs: number
  errorSummary?: string
}

export interface ProductAnalyticsPort extends AnalyticsClient {
  activate(experiments: ProductAnalyticsGate): Promise<void>
  markActive(reason: string): void
  canRecordEvents(): boolean
  dispose(): Promise<void>
}

export interface PollingLoop {
  start(listener: () => Promise<void>): { dispose(): void }
}

export interface HostTelemetryDependencies {
  readonly auth: {
    peekAccessToken(): string | null
    getAccessToken(...args: unknown[]): Promise<string>
    getMachineId(): Promise<string>
    subscribeToRenewal(listener: (result: CredentialRenewal) => void): () => void
    getLastRenewalEvent(): CredentialRenewal | null
  }
  readonly experiments: {
    checkGate(name: string): Promise<boolean>
    subscribe(listener: () => void): () => void
    hasHydratedExperimentUser(): boolean
    waitForHydratedExperimentUser(ms: number): Promise<boolean>
    getSlateModelExperimentState(): { active: boolean; arm: string } | null | undefined
    logSlateModelExperimentExposure(): boolean
    getDynamicConfig(name: string): Record<string, number> | undefined
    checkFeatureGate(name: string): boolean
  }
  readonly inference: { onModelExperimentApplied(listener: () => void): () => void }
  readonly identityTags?: Metadata
  readonly flushPolling?: PollingPolicy
  readonly submitDeadline?: DeadlinePolicy
  readonly identityHoldExpiry?: ExpiryPolicy
  readonly createStructuredLogClient?: () => StructuredLogClient
  readonly createProductAnalyticsClient?: () => ProductAnalyticsClient
  readonly boxLogPolling: PollingLoop
  readonly desktopHealthPolling: PollingLoop
  readonly hostCrashMarkerPolling: PollingLoop
  readonly hostCrashMarkerStore: HostCrashMarkerStore
  readonly fatalFlushDeadline: { run<T>(operation: () => Promise<T>): Promise<T> }
  readonly clock: { monotonicNow(): number }
  readonly hostLifecycleWatchdog: { arm(listener: () => void): { dispose(): void } }
  readonly desktopHealthPath?: string
  readonly createBoxLogShipper?: (deps: ConstructorParameters<typeof BoxLogShipper>[0]) => BoxLogShipping
  readonly analytics?: ProductAnalyticsPort
  readonly tracing?: HostTracing
  readonly logs?: import("./structured-log-telemetry.ts").SlateStructuredLogTelemetry
}

export interface MessageSentAnalyticsInput {
  readonly agentId: string
  readonly prompt?: string | undefined
  readonly attachmentPaths?: readonly string[] | undefined
  readonly richText?: string | undefined
  readonly isFork?: boolean | undefined
  readonly source?: string | undefined
  readonly isGroupRoom: boolean
}
