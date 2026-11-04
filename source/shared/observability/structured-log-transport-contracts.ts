import type { DeadlinePolicy, ExpiryPolicy, PollingPolicy } from "../../host/extensions/scheduling.ts";
import type { TelemetryDropReason } from "./telemetry-events.ts";

export type StructuredLogLevel = "debug" | "info" | "warn" | "error";

export enum ClientLogLevel {
  UNSPECIFIED = 0,
  INFO = 1,
  DEBUG = 2,
  WARN = 3,
  ERROR = 4,
}

export interface StructuredLogEntry {
  readonly level: ClientLogLevel;
  readonly message: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly timestamp: bigint;
  readonly key: string;
}

export interface BufferedStructuredLog {
  readonly level: StructuredLogLevel;
  readonly message: string;
  readonly metadata: Record<string, string>;
  readonly timestamp: number;
  readonly onSettled?: (settlement: "delivered" | "dropped") => void;
}

export interface DropCounter {
  observed: number;
  acknowledgedThrough: number;
}

export type DropCounters = Record<TelemetryDropReason, DropCounter>;

export interface StructuredLogCheckpoint {
  readonly counterId: string;
  readonly counters: DropCounters;
  readonly records: readonly BufferedStructuredLog[];
}

export interface StructuredLogClient {
  submitLogs(
    request: { readonly logs: readonly StructuredLogEntry[] },
    options: { readonly signal: AbortSignal },
  ): Promise<{ readonly logsProcessed: number; readonly logsDropped: number }>;
}

export interface StructuredLogTransportOptions {
  readonly platformTags: Readonly<Record<string, string | undefined>>;
  readonly key: string;
  readonly disabled?: boolean;
  readonly initialCheckpoint?: StructuredLogCheckpoint;
  readonly holdForIdentity?: boolean;
  readonly identityHoldExpiry?: ExpiryPolicy;
  readonly polling: PollingPolicy;
  readonly submitDeadline: DeadlinePolicy;
  createClient(): StructuredLogClient;
  readonly retainUndeliveredOnDispose?: boolean;
}
