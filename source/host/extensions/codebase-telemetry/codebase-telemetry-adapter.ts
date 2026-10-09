/**
 * The adapter in front of the codebase-telemetry helper.
 *
 * The helper is started with the account's credentials and its answers become the adapter's own state: every codebase
 * it reports is checked to be one of ours before it is published, a codebase the helper rejected fails the request,
 * and the helper dying is the adapter's terminal failure. Uploads are triggered on the helper's own polling, closed
 * over with the rest of the resources, and the credential each upload carries is fetched fresh per attempt.
 */

import { createDeadlinePolicy, realClock, type Clock, type DeadlinePolicy, type PollingPolicy } from "../scheduling.ts";
import { createWatchChannel, type WatchReceiver } from "./watch-channel.ts";

export const CodebaseEnvironment = { SLATE_BOX: 1 } as const;

/** A codebase the helper tracks, as the helper reports it. */
export interface TrackedCodebase {
  readonly codebaseUuid: string;
  readonly path: string;
  readonly kind: number;
  readonly environment: number;
}

export interface CsnapsState {
  readonly tracked: readonly TrackedCodebase[];
}

export interface CsnapsHandle {
  readonly terminalFailure: Promise<Error>;
  applyCodebaseSpecs(codebases: readonly unknown[]): Promise<{ state: CsnapsState; rejected: readonly unknown[] }>;
  snapshot(reason: unknown): Promise<void>;
  triggerUpload(credentials: Record<string, unknown>): Promise<void>;
  flushPendingUploads(credentials: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

export interface Logger {
  error(message: string, error?: unknown): void;
  warn(message: string, error?: unknown): void;
  info(message: string, error?: unknown): void;
  debug(message: string, error?: unknown): void;
}

/** A codebase of ours, with the account it belongs to: what the platform's telemetry may talk about. */
export interface AdapterCodebase {
  readonly codebaseUuid: string;
  readonly authId: string;
  readonly path: string;
  readonly kind: number;
  readonly environment: number;
}

export interface AdapterState {
  readonly trackedCodebases: readonly AdapterCodebase[];
  readonly isWithinStorageBudget: boolean;
}

export class CsnapsAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsnapsAdapterError";
  }
}

/** A codebase the helper reported that we would never have asked for. */
function assertCodebaseIsOurs(codebase: TrackedCodebase): void {
  if ((codebase.kind === 1 || codebase.kind === 2) && codebase.environment === CodebaseEnvironment.SLATE_BOX) return;
  throw new CsnapsAdapterError("csnaps returned a codebase outside Slate");
}

export function toCodebase(authId: string, codebase: TrackedCodebase): AdapterCodebase {
  assertCodebaseIsOurs(codebase);
  return { codebaseUuid: codebase.codebaseUuid, authId, path: codebase.path, kind: codebase.kind, environment: codebase.environment };
}

export function toAdapterState(authId: string, state: CsnapsState): AdapterState {
  return { trackedCodebases: state.tracked.map((codebase) => toCodebase(authId, codebase)), isWithinStorageBudget: true };
}

/** The timeouts each request to the helper runs under. */
function helperDeadlines(clock: Clock): Record<"ping" | "initialize" | "applyCodebaseSpecs" | "snapshot" | "triggerUpload" | "flushPendingUploads" | "shutdown" | "exit", DeadlinePolicy> {
  return {
    ping: createDeadlinePolicy(clock, { name: "csnaps-ping", timeoutMs: 10_000 }),
    initialize: createDeadlinePolicy(clock, { name: "csnaps-initialize", timeoutMs: 2 * 60_000 }),
    applyCodebaseSpecs: createDeadlinePolicy(clock, { name: "csnaps-apply-codebase-specs", timeoutMs: 10 * 60_000 }),
    snapshot: createDeadlinePolicy(clock, { name: "csnaps-snapshot", timeoutMs: 10 * 60_000 }),
    triggerUpload: createDeadlinePolicy(clock, { name: "csnaps-trigger-upload", timeoutMs: 30_000 }),
    flushPendingUploads: createDeadlinePolicy(clock, { name: "csnaps-flush-pending-uploads", timeoutMs: 30 * 60_000 }),
    shutdown: createDeadlinePolicy(clock, { name: "csnaps-shutdown", timeoutMs: 15_000 }),
    exit: createDeadlinePolicy(clock, { name: "csnaps-exit", timeoutMs: 3_000 }),
  };
}

export interface CsnapsAdapterCreateOptions {
  readonly credentials: { authId: string };
  readonly paths: { codebaseUuidStatePath: string; snapshotsBaseDir: string };
  readonly backendUrl: string;
  readonly csnapsBinPath: string;
  readonly spawnCsnaps: typeof import("./csnaps-process.ts").spawnCsnaps;
  readonly uploadPolling: PollingPolicy;
  readonly createUploadCredentials: () => Promise<Record<string, unknown>>;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
  /** The clock the helper's own timeouts run on; the real one unless a test says otherwise. */
  readonly clock?: Clock;
}

interface AdapterOptions {
  csnaps: CsnapsHandle;
  authId: string;
  initialState: CsnapsState;
  uploadPolling: PollingPolicy;
  createUploadCredentials: () => Promise<Record<string, unknown>>;
  logger: Logger;
}

type CleanupFailure = { kind: "cleanupFailed"; errors: readonly unknown[] };

export class CsnapsCodebaseTelemetryAdapter {
  readonly state: WatchReceiver<AdapterState>;
  readonly terminalFailure: Promise<Error>;
  private readonly stateChannel: ReturnType<typeof createWatchChannel<AdapterState>>;
  private uploadPolling: { dispose(): void } | undefined;
  private closePromise: Promise<{ kind: "closed" } | CleanupFailure> | undefined;

  static async create(options: CsnapsAdapterCreateOptions): Promise<CsnapsCodebaseTelemetryAdapter> {
    const spawned = await options.spawnCsnaps({
      executablePath: options.csnapsBinPath,
      initializeParams: {
        authId: options.credentials.authId,
        codebaseUuidStatePath: options.paths.codebaseUuidStatePath,
        snapshotsBaseDir: options.paths.snapshotsBaseDir,
        environment: CodebaseEnvironment.SLATE_BOX,
        backendUrl: options.backendUrl,
      },
      deadlines: helperDeadlines(options.clock ?? realClock),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return new CsnapsCodebaseTelemetryAdapter({
      csnaps: spawned.handle,
      authId: options.credentials.authId,
      initialState: spawned.initialState,
      uploadPolling: options.uploadPolling,
      createUploadCredentials: options.createUploadCredentials,
      logger: options.logger,
    });
  }

  constructor(private readonly options: AdapterOptions) {
    this.stateChannel = createWatchChannel(toAdapterState(options.authId, options.initialState), (error) => options.logger.error("Adapter state subscriber failed", error));
    this.state = this.stateChannel.receiver;
    const terminal = Promise.withResolvers<Error>();
    this.terminalFailure = terminal.promise;
    void options.csnaps.terminalFailure.then((error) => {
      // A helper that died after the adapter was let go has nothing left to report to.
      if (this.isDisposed) return;
      this.stateChannel.publish({ trackedCodebases: [], isWithinStorageBudget: false });
      terminal.resolve(error);
    });
  }

  async reconcileFeatureGates(_values: unknown): Promise<void> {}

  async setDesiredCodebases(codebases: readonly unknown[]): Promise<void> {
    if (this.isDisposed) return;
    const reconciled = await this.options.csnaps.applyCodebaseSpecs(codebases);
    if (this.isDisposed) return;
    if (reconciled.rejected.length > 0) throw new CsnapsAdapterError("csnaps rejected a required codebase");
    this.stateChannel.publish(toAdapterState(this.options.authId, reconciled.state));
    this.uploadPolling ??= this.options.uploadPolling.start(() => this.triggerUpload());
  }

  snapshot(reason: unknown): Promise<void> {
    return this.isDisposed ? Promise.resolve() : this.options.csnaps.snapshot(reason);
  }

  async runGitHistoryCapture(): Promise<void> {}

  async flushPendingUploads(): Promise<void> {
    if (this.isDisposed) return;
    const credentials = await this.options.createUploadCredentials();
    if (!this.isDisposed) await this.options.csnaps.flushPendingUploads(credentials);
  }

  close(): Promise<{ kind: "closed" } | CleanupFailure> {
    return (this.closePromise ??= this.releaseResources());
  }

  dispose(): void {
    void this.close().then(
      (result) => {
        if (result.kind === "cleanupFailed") this.options.logger.error("Failed to close adapter", result.errors);
      },
      (error) => this.options.logger.error("Failed to close adapter", error),
    );
  }

  /** Closed once it was asked to close, whether or not the closing itself succeeded. */
  private get isDisposed(): boolean {
    return this.closePromise != null;
  }

  private async releaseResources(): Promise<{ kind: "closed" } | CleanupFailure> {
    const errors: unknown[] = [];
    // Every step is attempted, and every failure is reported: a helper that would not close must not keep the
    // polling or the subscribers alive either.
    for (const step of [() => this.uploadPolling?.dispose(), () => this.options.csnaps.close(), () => this.stateChannel.stop()]) {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors.length === 0 ? { kind: "closed" } : { kind: "cleanupFailed", errors };
  }

  /** Uploading happens on the helper's own schedule, and once the adapter is closed it does not happen at all. */
  private async triggerUpload(): Promise<void> {
    if (this.isDisposed) return;
    try {
      const credentials = await this.options.createUploadCredentials();
      if (!this.isDisposed) await this.options.csnaps.triggerUpload(credentials);
    } catch (error) {
      if (!this.isDisposed) this.options.logger.warn("Failed to trigger snapshot upload", error);
    }
  }
}
