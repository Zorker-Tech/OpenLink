/**
 * Keeping the local-exec daemon alive.
 *
 * The supervisor starts the daemon with a generation of its own, watches it, and starts a fresh one when it stops —
 * bounded in how often it may do so, so a daemon that cannot stay up is reported rather than restarted forever.
 */
import { createRealPollingPolicy, type PollingPolicy } from "../../host/extensions/scheduling.ts";
import { SLATE_CLIENT_PAUSE_REASON } from "../../shared/gateway-reachability.ts";
import {
  commandCarriesLocalExecGeneration,
  localExecDiscoveryTimeMatchesProcess,
  sameLocalExecProcessIdentity,
  type ExpectedLocalExecProcessIdentity,
  type LocalExecProcessIdentity,
} from "../../shared/local-exec-process-identity.ts";
import {
  readLocalExecDaemonDiscovery,
  removeLocalExecDaemonFile,
  removeLocalExecDaemonDiscoveryIfMatches,
  resolveLocalExecDaemonPaths,
  writeLocalExecDaemonConnection,
  writeLocalExecDaemonCredential,
  writeLocalExecSupervisorHeartbeat
} from "./daemon-files.ts";

export const LOCAL_EXEC_DAEMON_REFRESH_INTERVAL_MS = 30_000;
export const LOCAL_EXEC_DAEMON_LIVENESS_INTERVAL_MS = 1_000;
export const LOCAL_EXEC_DAEMON_READINESS_TIMEOUT_MS = 5_000;
export const LOCAL_EXEC_DAEMON_READINESS_POLL_MS = 50;
export const LOCAL_EXEC_DAEMON_DISCOVERY_MISS_LIMIT = 2;
export const LOCAL_EXEC_DAEMON_RESPAWN_LIMIT = 10;

export function createLocalExecDaemonRefreshPolicy(): PollingPolicy {
  return createRealPollingPolicy({ name: "local-exec-daemon-refresh", intervalMs: LOCAL_EXEC_DAEMON_REFRESH_INTERVAL_MS });
}

export function createLocalExecDaemonLivenessPolicy(): PollingPolicy {
  return createRealPollingPolicy({ name: "local-exec-daemon-liveness", intervalMs: LOCAL_EXEC_DAEMON_LIVENESS_INTERVAL_MS });
}

export type LocalExecDaemonAction =
  | { readonly kind: "spawn" }
  | { readonly kind: "adopt"; readonly pid: number }
  | { readonly kind: "replace"; readonly pid: number };

export function decideLocalExecDaemonAction(existing: { readonly pid: number; readonly inflightCount?: number } | null): LocalExecDaemonAction {
  if (existing == null) return { kind: "spawn" };
  if ((existing.inflightCount ?? 0) > 0) return { kind: "adopt", pid: existing.pid };
  return { kind: "replace", pid: existing.pid };
}

export type LocalExecDaemonState =
  | { readonly phase: "absent" }
  | { readonly phase: "adopting" | "replacing"; readonly pid: number }
  | { readonly phase: "active"; readonly daemon: { readonly origin: "spawned" | "adopted"; readonly pid: number; readonly startedAt: number; readonly processStartEpochMs: number; readonly command: string; readonly entryRealpath: string; readonly generationToken: string } }
  | { readonly phase: "failed"; readonly reason: string };

interface LocalExecControl {
  resolveGatewayConnection(args: Record<string, never>): Promise<unknown>;
  mintLocalExecDaemonCredential(args: Record<string, never>): Promise<unknown | null>;
  spawnLocalExecDaemon(args: { readonly env: Readonly<Record<string, string>>; readonly logPath: string }): Promise<LocalExecProcessIdentity>;
  isProcessAlive(args: { readonly pid: number }): Promise<boolean>;
  getProcessIdentity(args: ExpectedLocalExecProcessIdentity): Promise<LocalExecProcessIdentity | null>;
  waitLocalExecDaemonExit(identity: LocalExecProcessIdentity): Promise<{ readonly identity: LocalExecProcessIdentity; readonly exitCode: number | null; readonly signal: string | null }>;
  terminateProcess(args: { readonly identity: LocalExecProcessIdentity }): Promise<{ readonly terminated: boolean }>;
}

export interface LocalExecDaemonSupervisorOptions {
  readonly dataDir: string;
  readonly isPackaged: boolean;
  readonly control: LocalExecControl;
  readonly refreshPolicy: PollingPolicy;
  readonly livenessPolicy?: PollingPolicy;
  readonly readinessTimeoutMs?: number;
  readonly readinessPollMs?: number;
  readonly now?: () => number;
  readonly delay?: (ms: number) => Promise<void>;
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isClientPauseRefusal(error: unknown): boolean {
  return error instanceof Error && error.message.includes(SLATE_CLIENT_PAUSE_REASON);
}

function isProcessIdentity(value: unknown): value is LocalExecProcessIdentity { if (typeof value !== "object" || value == null) return false; const identity = value as Partial<LocalExecProcessIdentity>; return Number.isInteger(identity.pid) && (identity.pid ?? 0) > 0 && typeof identity.startEpochMs === "number" && Number.isFinite(identity.startEpochMs) && typeof identity.command === "string" && identity.command.length > 0 && typeof identity.entryRealpath === "string" && identity.entryRealpath.length > 0 && typeof identity.generationToken === "string" && identity.generationToken.length > 0 && commandCarriesLocalExecGeneration(identity.command, identity.entryRealpath, identity.generationToken); }
function descriptorHasIdentity(discovery: { readonly entryRealpath?: string; readonly generationToken?: string }): discovery is { readonly entryRealpath: string; readonly generationToken: string } { return typeof discovery.entryRealpath === "string" && discovery.entryRealpath.length > 0 && typeof discovery.generationToken === "string" && discovery.generationToken.length > 0; }
function descriptorMatchesProcess(discovery: { readonly pid: number; readonly startedAt: number; readonly entryRealpath?: string; readonly generationToken?: string }, identity: LocalExecProcessIdentity, observedAtMs: number): boolean { return descriptorHasIdentity(discovery) && discovery.pid === identity.pid && localExecDiscoveryTimeMatchesProcess(discovery.startedAt, identity.startEpochMs, observedAtMs) && discovery.entryRealpath === identity.entryRealpath && discovery.generationToken === identity.generationToken && commandCarriesLocalExecGeneration(identity.command, identity.entryRealpath, identity.generationToken); }
function activeGeneration(origin: "spawned" | "adopted", discovery: { readonly pid: number; readonly startedAt: number }, identity: LocalExecProcessIdentity): Extract<LocalExecDaemonState, { phase: "active" }> { return { phase: "active", daemon: { origin, pid: discovery.pid, startedAt: discovery.startedAt, processStartEpochMs: identity.startEpochMs, command: identity.command, entryRealpath: identity.entryRealpath, generationToken: identity.generationToken } }; }
function identityFromActive(state: Extract<LocalExecDaemonState, { phase: "active" }>): LocalExecProcessIdentity { return { pid: state.daemon.pid, startEpochMs: state.daemon.processStartEpochMs, command: state.daemon.command, entryRealpath: state.daemon.entryRealpath, generationToken: state.daemon.generationToken }; }

export function createLocalExecDaemonSupervisor(settings: LocalExecDaemonSupervisorOptions) {
  const daemonPaths = resolveLocalExecDaemonPaths(settings.dataDir);
  let state: LocalExecDaemonState = { phase: "absent" };
  let hasStarted = false;
  let starting: Promise<void> | undefined;
  let credentialHanded = false;
  let isDisposed = false;
  let refreshTimer: { dispose(): void } | undefined;
  let livenessTimer: { dispose(): void } | undefined;
  let refreshVersion = 0;
  let descriptorWrites = Promise.resolve();
  let isPaused = false;
  let refusedForPause = false;
  let serialQueue = Promise.resolve();
  let missingDiscoveryCount = 0;
  let respawnCount = 0;
  let quarantinedProcess: LocalExecProcessIdentity | undefined;
  const clock = settings.now ?? Date.now;
  const wait = settings.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const readinessTimeout = settings.readinessTimeoutMs ?? LOCAL_EXEC_DAEMON_READINESS_TIMEOUT_MS;
  const readinessInterval = settings.readinessPollMs ?? LOCAL_EXEC_DAEMON_READINESS_POLL_MS;

  const serialized = async <T>(work: () => Promise<T>): Promise<T> => { const run = serialQueue.then(work); serialQueue = run.then(() => undefined, () => undefined); return run; };

  const identityOf = async (expected: ExpectedLocalExecProcessIdentity): Promise<LocalExecProcessIdentity | null> => { const identity = await settings.control.getProcessIdentity(expected); return isProcessIdentity(identity) ? identity : null; };
  const terminateOwned = async (expected: LocalExecProcessIdentity): Promise<boolean> => (await settings.control.terminateProcess({ identity: expected })).terminated;
  const quarantineBlocks = async (): Promise<boolean> => {
    if (quarantinedProcess == null) return false;
    const quarantined = quarantinedProcess;
    const observed = await identityOf(quarantined);
    if (observed != null && sameLocalExecProcessIdentity(observed, quarantined)) return true;
    if (await settings.control.isProcessAlive({ pid: quarantined.pid })) return true;
    quarantinedProcess = undefined;
    return false;
  };
  const watchSpawnedExit = (identity: LocalExecProcessIdentity) => { void settings.control.waitLocalExecDaemonExit(identity).then((settlement) => serialized(async () => { if (isDisposed || !sameLocalExecProcessIdentity(settlement.identity, identity) || state.phase !== "active" || !sameLocalExecProcessIdentity(identityFromActive(state), identity)) return; if (respawnCount >= LOCAL_EXEC_DAEMON_RESPAWN_LIMIT) { state = { phase: "failed", reason: "respawn limit reached" }; return; } state = { phase: "absent" }; if (!isPaused && !refusedForPause) { respawnCount += 1; await establishDaemonNow(); } }), () => {}); };

  const refreshConnectionNow = async () => {
    if (isDisposed || isPaused) return;
    const refreshId = ++refreshVersion;
    try {
      const connection = await settings.control.resolveGatewayConnection({});
      const write = descriptorWrites.then(async () => {
        if (isDisposed || refreshId !== refreshVersion) return;
        await writeLocalExecDaemonConnection(connection, daemonPaths.connectionPath);
      });
      descriptorWrites = write.then(() => undefined, () => undefined);
      await write;
      await writeLocalExecSupervisorHeartbeat(daemonPaths.supervisorHeartbeatPath);
      refusedForPause = false;
    } catch (error) {
      if (!isClientPauseRefusal(error)) return;
      refusedForPause = true;
      await retireForPause();
    }
  };

  const refreshCredentialNow = async () => {
    if (credentialHanded || isDisposed || isPaused) return;
    try {
      const credential = await settings.control.mintLocalExecDaemonCredential({});
      if (credential == null || isDisposed) return;
      await writeLocalExecDaemonCredential(credential, daemonPaths.credentialPath);
      credentialHanded = true;
    } catch {}
  };

  const spawnFreshDaemon = async () => {
    if (isPaused || refusedForPause) return;
    const spawned = await settings.control.spawnLocalExecDaemon({
      env: { ELECTRON_RUN_AS_NODE: "1", SLATE_PACKAGED: settings.isPackaged ? "1" : "0" },
      logPath: daemonPaths.logPath
    });
    if (!isProcessIdentity(spawned)) throw new Error("local-exec spawn did not return a valid daemon identity");
    watchSpawnedExit(spawned);
    const cleanupFailedSpawn = async () => {
      await terminateOwned(spawned);
      const discovery = await readLocalExecDaemonDiscovery(daemonPaths.discoveryPath);
      if (discovery != null
        && discovery.pid === spawned.pid
        && discovery.entryRealpath === spawned.entryRealpath
        && discovery.generationToken === spawned.generationToken) await removeLocalExecDaemonDiscoveryIfMatches(daemonPaths.discoveryPath, discovery);
    };
    try {
      const deadline = clock() + readinessTimeout;
      for (;;) {
        if (isDisposed || isPaused || refusedForPause) { await cleanupFailedSpawn(); return; }
        const discovery = await readLocalExecDaemonDiscovery(daemonPaths.discoveryPath);
        const observed = await identityOf(spawned);
        if (observed == null || !sameLocalExecProcessIdentity(observed, spawned)) throw new Error(`local-exec daemon ${spawned.pid} exited or changed identity before readiness`);
        if (discovery != null && descriptorMatchesProcess(discovery, spawned, clock())) {
          quarantinedProcess = undefined;
          state = activeGeneration("spawned", discovery, spawned);
          missingDiscoveryCount = 0;
          return;
        }
        if (clock() >= deadline) throw new Error(`local-exec daemon ${spawned.pid} did not publish matching discovery before readiness timeout`);
        await wait(readinessInterval);
      }
    } catch (error) {
      await cleanupFailedSpawn();
      throw error;
    }
  };

  const retireForPause = async () => {
    refreshVersion += 1;
    try {
      if (await quarantineBlocks()) {
        const existing = await readLocalExecDaemonDiscovery(daemonPaths.discoveryPath);
        if (existing != null) await removeLocalExecDaemonDiscoveryIfMatches(daemonPaths.discoveryPath, existing);
        await removeLocalExecDaemonFile(daemonPaths.connectionPath);
        state = { phase: "failed", reason: "local-exec active discovery generation changed while its verified process remained live" };
        missingDiscoveryCount = 0;
        return;
      }
      const active = state.phase === "active" ? state : null;
      if (active != null) await terminateOwned(identityFromActive(active));
      const existing = await readLocalExecDaemonDiscovery(daemonPaths.discoveryPath);
      if (existing != null) {
        const identity = descriptorHasIdentity(existing) ? await identityOf({ ...existing, discoveryStartedAt: existing.startedAt }) : null;
        if (identity != null && descriptorMatchesProcess(existing, identity, clock())) await terminateOwned(identity);
        await removeLocalExecDaemonDiscoveryIfMatches(daemonPaths.discoveryPath, existing);
      }
      await removeLocalExecDaemonFile(daemonPaths.connectionPath);
      quarantinedProcess = undefined;
      state = { phase: "absent" };
      missingDiscoveryCount = 0;
    } catch (error) { state = { phase: "failed", reason: failureReason(error) }; }
  };

  const establishDaemonNow = async () => {
    if (isPaused || refusedForPause) return;
    try {
      const existing = await readLocalExecDaemonDiscovery(daemonPaths.discoveryPath);
      if (isDisposed) return;
      if (existing != null) {
        const identity = descriptorHasIdentity(existing) ? await identityOf({ ...existing, discoveryStartedAt: existing.startedAt }) : null;
        if (identity == null || !descriptorMatchesProcess(existing, identity, clock())) {
          await removeLocalExecDaemonDiscoveryIfMatches(daemonPaths.discoveryPath, existing);
          await spawnFreshDaemon();
          return;
        }
        if ((existing.inflightCount ?? 0) > 0) {
          quarantinedProcess = undefined;
          state = { phase: "adopting", pid: existing.pid };
          state = activeGeneration("adopted", existing, identity);
          missingDiscoveryCount = 0;
          return;
        }
        state = { phase: "replacing", pid: existing.pid };
        await terminateOwned(identity);
        if (isDisposed) return;
        await removeLocalExecDaemonDiscoveryIfMatches(daemonPaths.discoveryPath, existing);
        await spawnFreshDaemon();
        return;
      }
      await spawnFreshDaemon();
    } catch (error) {
      state = { phase: "failed", reason: failureReason(error) };
    }
  };

  const healNow = async () => {
    if (isPaused || refusedForPause) { await retireForPause(); return; }
    if (state.phase === "absent") { respawnCount = 0; await establishDaemonNow(); return; }
    if (state.phase === "failed") {
      if (await quarantineBlocks()) return;
      if (respawnCount >= LOCAL_EXEC_DAEMON_RESPAWN_LIMIT) return;
      respawnCount += 1;
      await establishDaemonNow();
      return;
    }
    if (state.phase !== "active") return;
    let discovery;
    try { discovery = await readLocalExecDaemonDiscovery(daemonPaths.discoveryPath); }
    catch (error) { state = { phase: "failed", reason: `local-exec discovery unreadable: ${failureReason(error)}` }; return; }
    const active = state;
    const activeIdentity = identityFromActive(active);
    if (discovery == null) {
      missingDiscoveryCount += 1;
      if (missingDiscoveryCount < LOCAL_EXEC_DAEMON_DISCOVERY_MISS_LIMIT) return;
      await terminateOwned(activeIdentity);
      state = { phase: "absent" };
    } else if (discovery.pid === active.daemon.pid
      && discovery.startedAt === active.daemon.startedAt
      && discovery.entryRealpath === active.daemon.entryRealpath
      && discovery.generationToken === active.daemon.generationToken) {
      const observed = await identityOf(activeIdentity);
      if (observed != null && sameLocalExecProcessIdentity(observed, activeIdentity)) { missingDiscoveryCount = 0; respawnCount = 0; return; }
      await removeLocalExecDaemonDiscoveryIfMatches(daemonPaths.discoveryPath, discovery);
      state = { phase: "absent" };
    } else {
      if (discovery.pid === active.daemon.pid) {
        await removeLocalExecDaemonDiscoveryIfMatches(daemonPaths.discoveryPath, discovery);
        const observed = await identityOf(activeIdentity);
        if (observed != null && sameLocalExecProcessIdentity(observed, activeIdentity)) {
          quarantinedProcess = activeIdentity;
          missingDiscoveryCount = 0;
          state = { phase: "failed", reason: "local-exec active discovery generation changed while its verified process remained live" };
          return;
        }
        state = { phase: "absent" };
      } else {
        const successorIdentity = descriptorHasIdentity(discovery) ? await identityOf({ ...discovery, discoveryStartedAt: discovery.startedAt }) : null;
        if (successorIdentity != null && descriptorMatchesProcess(discovery, successorIdentity, clock())) {
          await terminateOwned(activeIdentity);
          quarantinedProcess = undefined;
          state = activeGeneration("adopted", discovery, successorIdentity);
          missingDiscoveryCount = 0;
          respawnCount = 0;
          return;
        }
        await removeLocalExecDaemonDiscoveryIfMatches(daemonPaths.discoveryPath, discovery);
        await terminateOwned(activeIdentity);
        state = { phase: "absent" };
      }
    }
    if (respawnCount >= LOCAL_EXEC_DAEMON_RESPAWN_LIMIT) {
      state = { phase: "failed", reason: "respawn limit reached" };
      return;
    }
    respawnCount += 1;
    await establishDaemonNow();
  };
  const healDaemonNow = async () => {
    try { await healNow(); }
    catch (error) { state = { phase: "failed", reason: `local-exec serialQueue failed: ${failureReason(error)}` }; }
  };

  return {
    async start(): Promise<void> {
      if (starting !== undefined) return starting;
      if (isDisposed) return;
      hasStarted = true;
      starting = (async () => {
        await serialized(async () => { await refreshConnectionNow(); await refreshCredentialNow(); if (!isDisposed) await establishDaemonNow(); });
        if (isDisposed) return;
        let absorbedImmediateTick = false;
        refreshTimer = settings.refreshPolicy.start(async () => {
          if (!absorbedImmediateTick) { absorbedImmediateTick = true; return; }
          await serialized(async () => { await refreshConnectionNow(); await refreshCredentialNow(); });
        });
        let absorbedImmediateLivenessTick = false;
        livenessTimer = (settings.livenessPolicy ?? createLocalExecDaemonLivenessPolicy()).start(async () => {
          if (!absorbedImmediateLivenessTick) { absorbedImmediateLivenessTick = true; return; }
          await serialized(healDaemonNow);
        });
      })();
      return starting;
    },
    refreshConnection: () => serialized(refreshConnectionNow),
    async setPaused(next: boolean): Promise<void> {
      await serialized(async () => {
        if (isDisposed || isPaused === next) return;
        isPaused = next;
        if (next) { await retireForPause(); return; }
        if (!hasStarted) return;
        await refreshConnectionNow();
        await refreshCredentialNow();
        if (await quarantineBlocks()) {
          state = { phase: "failed", reason: "local-exec active discovery generation changed while its verified process remained live" };
          return;
        }
        await establishDaemonNow();
      });
    },
    state: () => state,
    whenIdle: () => serialQueue,
    dispose(): Promise<void> {
      if (isDisposed) return serialQueue;
      isDisposed = true;
      refreshTimer?.dispose();
      refreshTimer = undefined;
      livenessTimer?.dispose();
      livenessTimer = undefined;
      return serialized(async () => {});
    }
  };
}