/**
 * The host's runtime pieces, eleventh group: the mark a host that died leaves behind, how far a start got and what is
 * said about it, and the box this build offers.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { shellExecutorResource } from "../../source/packages/agent-exec/shell.ts";
import { writeExecutorResource } from "../../source/packages/agent-exec/write-operation.ts";
import { createContext } from "../../source/packages/context/context.ts";
import { createProductionBoxInner, type ErasedProductionBoxGeneratedPorts, type ProductionBoxGeneratedPorts } from "../../source/host/boxes/production.ts";
import type { LoopbackTelemetry } from "../../source/host/boxes/loopback-slate-box.ts";
import { deleteIfUnchanged, createHostCrashMarkerStore, forwardHostCrashMarkerWith, HOST_CRASH_EXIT_SIGNALS, hostCrashMarkerMetadata, isFatalExitSignal, isNonNegativeFinite, parseHostCrashMarker, parseJson, readCommonTimes, type HostCrashMarker } from "../../source/host/telemetry/host-crash-marker.ts";
import { BOX_IMAGE_CHECK_EVENT, BOX_BOOT_FAILURE_EVENT, BOX_BOOT_STAGE_EVENT, BOX_PROCESS_CRASH_EVENT, COOKIE_PERSIST_EVENT, DAEMON_PING_EVENT, EGRESS_TUNNEL_EVENT, EXEC_DAEMON_RESTART_EVENT, HOST_BOOT_FETCH_EVENT, HOST_LIFECYCLE_EVENT, HOST_STARTUP_EVENT, SUPERVISOR_RESTART_EVENT, boxImageCheckTelemetry, boxInfrastructureTelemetry, daemonPingTelemetry, hostLifecycleTelemetry, hostStartupTelemetry } from "../../source/host/telemetry/lifecycle-telemetry.ts";
import { SlateError } from "../../source/shared/errors/registry.ts";

describe("the mark a host that died leaves behind", () => {
  const directory = () => mkdtempSync(join(tmpdir(), "slate-crash-marker-"));

  it("keeps the signals a fatal exit is, and refuses the ones that are not", () => {
    assert.equal(HOST_CRASH_EXIT_SIGNALS.includes("SIGSEGV"), true);
    assert.equal(HOST_CRASH_EXIT_SIGNALS.includes("SIGKILL"), true);
    assert.equal(isFatalExitSignal("SIGSEGV"), true);
    assert.equal(isFatalExitSignal("SIGKILL"), true);
    // An exit that named no signal, or one the platform does not know, is not a fatal one.
    assert.equal(isFatalExitSignal("none"), false);
    assert.equal(isFatalExitSignal("unknown"), false);
    assert.equal(isFatalExitSignal("SIGWHATEVER"), false);
    assert.equal(isFatalExitSignal(9), false);
    assert.equal(isNonNegativeFinite(0), true);
    assert.equal(isNonNegativeFinite(-1), false);
    assert.equal(isNonNegativeFinite(Number.POSITIVE_INFINITY), false);
    assert.equal(isNonNegativeFinite("1"), false);
    assert.deepEqual(parseJson('{"a":1}'), { kind: "parsed", value: { a: 1 } });
    assert.deepEqual(parseJson("{not json"), { kind: "invalid" });
    assert.deepEqual(readCommonTimes({ startedAtMs: 1, crashedAtMs: 2, uptimeMs: 3 }), { startedAtMs: 1, crashedAtMs: 2, uptimeMs: 3 });
    assert.equal(readCommonTimes({ startedAtMs: 1, crashedAtMs: 2 }), null);
    assert.equal(readCommonTimes({ startedAtMs: 1, crashedAtMs: -2, uptimeMs: 3 }), null);
  });

  it("reads a marker back only when it says exactly what happened", () => {
    const signal = { schemaVersion: 1, errorClass: "signal_exit", exitSignal: "SIGSEGV", startedAtMs: 10, crashedAtMs: 20, uptimeMs: 10 };
    assert.deepEqual(parseHostCrashMarker(JSON.stringify(signal)), signal);
    const nonzero = { schemaVersion: 1, errorClass: "nonzero_exit", exitSignal: "none", startedAtMs: 1, crashedAtMs: 2, uptimeMs: 1 };
    assert.deepEqual(parseHostCrashMarker(JSON.stringify(nonzero)), nonzero);
    assert.deepEqual(parseHostCrashMarker(JSON.stringify({ ...nonzero, errorClass: "unexpected_clean_exit" })), { ...nonzero, errorClass: "unexpected_clean_exit" });
    // A host that vanished without either a signal or an exit code records less, and may record only when it was seen.
    const unobserved = { schemaVersion: 1, errorClass: "unobserved_exit", exitSignal: "unknown", crashedAtMs: 5 };
    assert.deepEqual(parseHostCrashMarker(JSON.stringify(unobserved)), unobserved);
    assert.deepEqual(parseHostCrashMarker(JSON.stringify({ ...unobserved, startedAtMs: 1, uptimeMs: 4 })), { ...unobserved, startedAtMs: 1, uptimeMs: 4 });
    // Everything that does not say exactly what happened is refused rather than guessed at.
    assert.equal(parseHostCrashMarker("{not json"), null);
    assert.equal(parseHostCrashMarker("null"), null);
    assert.equal(parseHostCrashMarker("[]"), null);
    assert.equal(parseHostCrashMarker(JSON.stringify({ ...signal, schemaVersion: 2 })), null);
    assert.equal(parseHostCrashMarker(JSON.stringify({ ...signal, errorClass: "something_new" })), null);
    assert.equal(parseHostCrashMarker(JSON.stringify({ ...signal, exitSignal: "none" })), null);
    assert.equal(parseHostCrashMarker(JSON.stringify({ ...signal, uptimeMs: 10 }) === "" ? "" : JSON.stringify({ schemaVersion: 1, errorClass: "signal_exit", exitSignal: "SIGSEGV" })), null);
    assert.equal(parseHostCrashMarker(JSON.stringify({ ...unobserved, startedAtMs: -1 })), null);
    assert.equal(parseHostCrashMarker(JSON.stringify({ ...nonzero, crashedAtMs: Number.NaN })), null);
    assert.equal(parseHostCrashMarker(JSON.stringify({ ...nonzero, errorClass: "nonzero_exit", exitSignal: "SIGTERM" })), null);
  });

  it("reports the marker as tags, with the numbers as whole milliseconds", () => {
    const marker: HostCrashMarker = { schemaVersion: 1, errorClass: "signal_exit", exitSignal: "SIGSEGV", startedAtMs: 10.6, crashedAtMs: 20.4, uptimeMs: 9.6 };
    assert.deepEqual(hostCrashMarkerMetadata(marker), { kind: "process_exit", error_class: "signal_exit", exit_signal: "SIGSEGV", started_at_ms: "11", crashed_at_ms: "20", uptime_ms: "10" });
    // What the marker does not know is left out rather than sent as an empty tag.
    assert.deepEqual(hostCrashMarkerMetadata({ schemaVersion: 1, errorClass: "unobserved_exit", exitSignal: "unknown", crashedAtMs: 5 }), { kind: "process_exit", error_class: "unobserved_exit", exit_signal: "unknown", crashed_at_ms: "5" });
  });

  it("reads the marker from where the host keeps it, and takes it away once it is dealt with", async () => {
    const root = directory();
    const path = join(root, "host-crash-marker.json");
    const store = createHostCrashMarkerStore(path);
    assert.deepEqual(await store.read(), { kind: "absent" });
    writeFileSync(path, "raw marker");
    assert.deepEqual(await store.read(), { kind: "present", raw: "raw marker" });
    assert.equal(await store.delete(), "deleted");
    assert.deepEqual(await store.read(), { kind: "absent" });
    assert.equal(await store.delete(), "deleted");
    assert.equal(existsSync(path), false);
    // A marker that cannot be read at all is reported as such rather than as absent.
    mkdirSync(join(root, "a-directory"));
    const unreadable = createHostCrashMarkerStore(join(root, "a-directory"));
    assert.deepEqual(await unreadable.read(), { kind: "unavailable" });
    rmSync(join(root, "a-directory"), { recursive: true, force: true });
  });

  it("takes the marker away only while it is still the one that was read", async () => {
    const root = directory();
    const path = join(root, "marker.json");
    const store = createHostCrashMarkerStore(path);
    assert.equal(await deleteIfUnchanged(store, "anything"), "deleted");
    writeFileSync(path, "first");
    assert.equal(await deleteIfUnchanged(store, "second"), "changed");
    assert.equal(readFileSync(path, "utf8"), "first");
    assert.equal(await deleteIfUnchanged(store, "first"), "deleted");
    const unreadable = createHostCrashMarkerStore(root);
    assert.equal(await deleteIfUnchanged(unreadable, "first"), "failed");
  });

  it("forwards a marker once, and only forgets it after it arrived", async () => {
    const marker: HostCrashMarker = { schemaVersion: 1, errorClass: "signal_exit", exitSignal: "SIGSEGV", startedAtMs: 1, crashedAtMs: 2, uptimeMs: 1 };
    const raw = JSON.stringify(marker);
    function harness(options: { read?: "absent" | "unavailable" | "present"; forwarded?: boolean; emit?: boolean; delete?: "deleted" | "unavailable" } = {}) {
      const read = options.read ?? "present";
      const forwarded = new Set<string>(options.forwarded === true ? [raw] : []);
      const deleted: string[] = [];
      const emitted: HostCrashMarker[] = [];
      const forwarder = {
        store: {
          read: async () => (read === "present" ? { kind: "present" as const, raw } : { kind: read }),
          delete: async () => { deleted.push("delete"); return options.delete ?? "deleted"; },
        },
        wasForwarded: (value: string) => forwarded.has(value),
        markForwarded: (value: string) => { forwarded.add(value); },
        emit: async (value: HostCrashMarker) => { emitted.push(value); return options.emit ?? true; },
      };
      return { forwarder, forwarded, deleted, emitted };
    }
    const absent = harness({ read: "absent" });
    assert.equal(await forwardHostCrashMarkerWith(absent.forwarder), "absent");
    assert.deepEqual(absent.deleted, []);
    const unavailable = harness({ read: "unavailable" });
    assert.equal(await forwardHostCrashMarkerWith(unavailable.forwarder), "deferred");
    // It is emitted and then removed, and only then is it forgotten.
    const delivered = harness();
    assert.equal(await forwardHostCrashMarkerWith(delivered.forwarder), "delivered");
    assert.deepEqual(delivered.emitted, [marker]);
    assert.deepEqual(delivered.deleted, ["delete"]);
    // Nothing to send, or nothing able to take it, leaves it in place to try again.
    assert.equal(await forwardHostCrashMarkerWith(harness({ emit: false }).forwarder), "deferred");
    assert.equal(await forwardHostCrashMarkerWith(harness({ delete: "unavailable" }).forwarder), "delete_deferred");
    // A marker that was already forwarded is not sent twice; it is only taken away.
    const already = harness({ forwarded: true });
    assert.equal(await forwardHostCrashMarkerWith(already.forwarder), "delivered");
    assert.deepEqual(already.emitted, []);
    // A marker that cannot be read is taken away without being reported as a crash.
    const broken = harness({ read: "present" });
    broken.forwarder.store.read = async () => ({ kind: "present", raw: "{not json" });
    assert.equal(await forwardHostCrashMarkerWith(broken.forwarder), "parse_error");
    assert.deepEqual(broken.emitted, []);
    assert.deepEqual(broken.deleted, ["delete"]);
    assert.equal(broken.forwarded.has("{not json"), true);
  });
});

describe("how far a start got, and what is said about it", () => {
  it("uses our own event names", () => {
    assert.deepEqual([HOST_STARTUP_EVENT, HOST_LIFECYCLE_EVENT, DAEMON_PING_EVENT, BOX_IMAGE_CHECK_EVENT, BOX_BOOT_STAGE_EVENT, BOX_BOOT_FAILURE_EVENT, EGRESS_TUNNEL_EVENT, HOST_BOOT_FETCH_EVENT, EXEC_DAEMON_RESTART_EVENT, SUPERVISOR_RESTART_EVENT, COOKIE_PERSIST_EVENT, BOX_PROCESS_CRASH_EVENT], [
      "slate.host.startup", "slate.host.lifecycle", "slate.box.daemon_ping", "slate.box.image_check", "slate.box.boot_stage",
      "slate.box.boot_failure", "slate.box.egress_tunnel", "slate.box.host_boot_fetch", "slate.box.exec_daemon_restart",
      "slate.box.supervisor_restart", "slate.box.cookie_persist", "slate.box.process_crash",
    ]);
  });

  it("says which build started, with what the caller knows about it", () => {
    assert.deepEqual(hostStartupTelemetry({ host_version: "1" }, "1234"), { level: "info", event: HOST_STARTUP_EVENT, metadata: { host_built_at_ms: "1234", host_version: "1" } });
  });

  it("says which phase a start is in, and how it went", () => {
    assert.deepEqual(hostLifecycleTelemetry({ phase: "plugin_graph", outcome: "completed", durationMs: 12, pluginCount: 3 }), { level: "info", event: HOST_LIFECYCLE_EVENT, metadata: { phase: "plugin_graph", outcome: "completed", duration_ms: "12", plugin_count: "3", entry_count: undefined } });
    // The count a phase carries is only reported when that phase finished and it is the count for that phase.
    assert.deepEqual(hostLifecycleTelemetry({ phase: "transcript_read", outcome: "completed", durationMs: 5, entryCount: 7 }), { level: "info", event: HOST_LIFECYCLE_EVENT, metadata: { phase: "transcript_read", outcome: "completed", duration_ms: "5", plugin_count: undefined, entry_count: "7" } });
    const stuck = hostLifecycleTelemetry({ phase: "auth", outcome: "stuck", durationMs: 3_000, error: SlateError.hostLifecycleStalled({ phase: "auth" }) });
    assert.equal(stuck.level, "warn");
    const stuckTags = stuck.metadata as Record<string, string | undefined>;
    assert.equal(stuckTags.error_code, "SLATE-E0302");
    // A phase that did not finish carries the error's own tags, so the failure is legible on its own.
    const failed = hostLifecycleTelemetry({ phase: "auth", outcome: "failed", durationMs: 9, error: SlateError.hostLifecycleFailed({ phase: "auth" }) });
    assert.equal(failed.level, "error");
    const failedTags = failed.metadata as Record<string, string | undefined>;
    assert.equal(typeof failedTags.error_domain, "string");
    assert.equal(failedTags.error_retryable, "true");
  });

  it("reports a box daemon's ping as a warning when it answered, and an error when it did not", () => {
    const ok = daemonPingTelemetry({ outcome: "ok", attempts: 2, durationMs: 30, unreadyDurationMs: 10, readinessState: "ready", target: "127.0.0.1:1337" });
    assert.equal(ok.level, "warn");
    assert.deepEqual(ok.metadata, { outcome: "ok", attempts: "2", duration_ms: "30", unready_duration_ms: "10", readiness_state: "ready", target: "127.0.0.1:1337", cause: undefined });
    const timeout = daemonPingTelemetry({ outcome: "timeout", attempts: 3, durationMs: 3_000, unreadyDurationMs: 3_000, readinessState: "unready", target: "127.0.0.1:1337", causeSummary: "connect ETIMEDOUT" });
    assert.equal(timeout.level, "error");
    assert.equal(timeout.metadata.cause, "connect ETIMEDOUT");
  });

  it("reports the image check with the reason it was skipped, or the error it hit", () => {
    const skipped = boxImageCheckTelemetry({ trigger: "manual", outcome: "skipped", durationMs: 1, skipReason: "not packaged" });
    assert.deepEqual({ level: skipped.level, skip_reason: skipped.metadata.skip_reason }, { level: "info", skip_reason: "not packaged" });
    const answered = boxImageCheckTelemetry({ trigger: "manual", outcome: "answered", durationMs: 2 });
    assert.equal(answered.level, "info");
    assert.equal(answered.metadata.skip_reason, undefined);
    const timedOut = boxImageCheckTelemetry({ trigger: "manual", outcome: "timeout", durationMs: 900, error: SlateError.boxImageCheckTimedOut({}) });
    assert.equal(timedOut.level, "warn");
    assert.equal((timedOut.metadata as Record<string, string | undefined>).error_code, "SLATE-E0304");
  });

  it("reports each thing the box did as the platform's own event, and passes on what it does not know", () => {
    assert.deepEqual(boxInfrastructureTelemetry({ kind: "boot_stage", stage: "starting", durationMs: 5 }), { level: "info", event: BOX_BOOT_STAGE_EVENT, metadata: { stage: "starting", duration_ms: "5" } });
    assert.deepEqual(boxInfrastructureTelemetry({ kind: "boot_stage", stage: "ready", durationMs: 50 }), { level: "warn", event: BOX_BOOT_STAGE_EVENT, metadata: { stage: "ready", duration_ms: "50" } });
    assert.deepEqual(boxInfrastructureTelemetry({ kind: "boot_failure", stage: "starting", reason: "no image", durationMs: 9 }), { level: "error", event: BOX_BOOT_FAILURE_EVENT, metadata: { stage: "starting", reason: "no image", duration_ms: "9" } });
    assert.deepEqual(boxInfrastructureTelemetry({ kind: "egress_tunnel", outcome: "ready", attempt: 1, runtimeS: 2 }), { level: "info", event: EGRESS_TUNNEL_EVENT, metadata: { outcome: "ready", attempt: "1", exit_status: undefined, runtime_s: "2" } });
    assert.deepEqual(boxInfrastructureTelemetry({ kind: "egress_tunnel", outcome: "failed", attempt: 2, exitStatus: 7, runtimeS: 3 }), { level: "warn", event: EGRESS_TUNNEL_EVENT, metadata: { outcome: "failed", attempt: "2", exit_status: "7", runtime_s: "3" } });
    assert.deepEqual(boxInfrastructureTelemetry({ kind: "host_boot_fetch", outcome: "fallback", reason: "offline", durationMs: 4, swapMs: 30, fromVersion: "1", toVersion: "2" }).metadata, { outcome: "fallback", reason: "offline", duration_ms: "4", swap_ms: "30", from_version: "1", to_version: "2" });
    assert.equal(boxInfrastructureTelemetry({ kind: "host_boot_fetch", outcome: "restore_failed", reason: "no backup", durationMs: 4 }).level, "error");
    assert.deepEqual(boxInfrastructureTelemetry({ kind: "exec_daemon_restart", restartAttempt: 2, runtimeS: 5, cause: "exit", exitStatus: 1 }), { level: "error", event: EXEC_DAEMON_RESTART_EVENT, metadata: { restart_attempt: "2", runtime_s: "5", cause: "exit", exit_status: "1" } });
    assert.deepEqual(boxInfrastructureTelemetry({ kind: "supervisor_restart", restartAttempt: 1, runtimeS: 6, cause: "signal", exitStatus: 9 }), { level: "error", event: SUPERVISOR_RESTART_EVENT, metadata: { restart_attempt: "1", runtime_s: "6", cause: "signal", exit_status: "9" } });
    assert.deepEqual(boxInfrastructureTelemetry({ kind: "cookie_persist", phase: "seed", outcome: "ok", seedCookies: 3 }).metadata, { phase: "seed", outcome: "ok", seed_cookies: "3", injected: undefined, missing_after: undefined, attempts: undefined });
    assert.equal(boxInfrastructureTelemetry({ kind: "cookie_persist", phase: "seed", outcome: "failed", seedCookies: 3, injected: 2, missingAfter: 1, attempts: 4 }).level, "error");
    assert.deepEqual(boxInfrastructureTelemetry({ kind: "process_crash", binary: "exec", signal: "SIGSEGV", count: 2 }), { level: "warn", event: BOX_PROCESS_CRASH_EVENT, metadata: { binary: "exec", signal: "SIGSEGV", count: "2" } });
    // Something this build does not know is passed on as it arrived rather than dropped.
    assert.deepEqual(boxInfrastructureTelemetry({ kind: "something_else", keep: "as-is" }), { kind: "something_else", keep: "as-is" });
  });
});

describe("the box this build offers", () => {
  /** The box's generated ports, faked at the boundary the platform hands them over. */
  function generatedPorts() {
    const transports: Array<{ baseUrl: string; httpVersion: string; useBinaryFormat: boolean; interceptors: unknown[] }> = [];
    const controlCalls: Array<[string, unknown]> = [];
    const shells: string[] = [];
    const writes: Array<{ path: string; bytes: number }> = [];
    const executors = new Map<unknown, { execute(ctx: unknown, args: Record<string, unknown>): Promise<unknown> }>([
      [shellExecutorResource, { execute: async (_ctx, args) => { shells.push(String(args.command)); return { outcome: { kind: "success", command: String(args.command), workingDirectory: "/workspace", exitCode: 0, signal: "", stdout: "", stderr: "", executionTimeMs: 0 } }; } }],
      [writeExecutorResource, { execute: async (_ctx, args) => { const bytes = args.bytes as Uint8Array | undefined; writes.push({ path: String(args.path), bytes: bytes?.length ?? 0 }); return { kind: "success", path: String(args.path), linesWritten: 0, bytesWritten: bytes?.length ?? 0 }; } }],
    ]);
    const accessor = { get: (resource: unknown) => executors.get(resource) ?? { execute: async () => ({ outcome: { kind: "unrecognized" } }) } };
    const transportMarker = { control: {}, exec: {}, accessor };
    const generated = {
      createTransport: (options: (typeof transports)[number]) => { transports.push(options); return transportMarker; },
      createControlClient: () => ({
        ping: async (_ctx: unknown, _request: unknown, options: unknown) => { controlCalls.push(["ping", options]); return {}; },
        updateEnvironmentVariables: async (_ctx: unknown, request: unknown) => { controlCalls.push(["env", request]); return {}; },
        loadServers: async (_ctx: unknown, configurationJson: string) => { controlCalls.push(["mcp", configurationJson]); return ["from-config"]; },
      }),
      createExecClient: () => ({ exec: async function* () { /* no elements */ } }),
      createResourceAccessor: () => ({ ...accessor, wrapped: true }),
      withFileReadGuard: (value: { guarded?: boolean }) => ({ ...value, guarded: true }),
      withNoMonitorComputerUse: (value: { noMonitor?: boolean }) => ({ ...value, noMonitor: true }),
    };
    return { generated: generated as unknown as ErasedProductionBoxGeneratedPorts, transports, controlCalls, shells, writes };
  }

  const options = (generated: ErasedProductionBoxGeneratedPorts, sharedDesktop?: boolean) => ({ generated, telemetry: {} as LoopbackTelemetry, protectedBoxPaths: [], host: "127.0.0.1", authToken: "local", ...(sharedDesktop === undefined ? {} : { sharedDesktop }) });

  it("reaches the box through the transport for its endpoint, and asks it what it can do", async () => {
    const ports = generatedPorts();
    const inner = createProductionBoxInner(options(ports.generated, false));
    const context = createContext().withName("box");
    assert.equal(await inner.runState(context, "agent-1"), "running");
    assert.equal((await inner.listBoxes()).length > 0, true);
    assert.equal(inner.getAgentWindowIndex?.("agent-1"), 1);
    assert.equal(inner.maxWindows?.(), 1);
    assert.equal(inner.getTerminalsFolder?.(), "/root/.slate/projects/workspace/terminals");
    assert.equal(await inner.isAvailable?.(), true);
    assert.deepEqual(inner.describe?.(), { backend: "loopback" });

    await inner.applyEnvironment?.(context, { env: { SLATE_BOX_MODE: "release" }, replace: true });
    assert.deepEqual(ports.transports.at(-1), { httpVersion: "1.1", baseUrl: "http://127.0.0.1:1337", useBinaryFormat: true, interceptors: [ports.transports.at(-1)?.interceptors[0]] });
    assert.equal(ports.transports.at(-1)?.interceptors.every((entry) => typeof entry === "function"), true);
    assert.deepEqual(ports.controlCalls.at(-1), ["env", { env: { SLATE_BOX_MODE: "release" }, replace: true }]);
    // What the box says it loaded is handed back to the caller.
    assert.deepEqual(await inner.loadMcpServers?.(context, "{}"), ["from-config"]);
    assert.deepEqual(ports.controlCalls.at(-1), ["mcp", "{}"]);
  });

  it("refuses an environment update it cannot understand, before it reaches the box", () => {
    const ports = generatedPorts();
    const inner = createProductionBoxInner(options(ports.generated, false));
    const context = createContext().withName("box");
    // The shape is checked where the box takes it, so a bad update is refused rather than forwarded.
    assert.throws(() => { void inner.applyEnvironment?.(context, { env: { A: 1 }, replace: true }); }, { name: "TypeError", message: "box environment value for A must be a string" });
    assert.throws(() => { void inner.applyEnvironment?.(context, { env: "A=1", replace: true }); }, { name: "TypeError", message: "box environment update has an invalid shape" });
    assert.throws(() => { void inner.applyEnvironment?.(context, { env: {}, replace: "yes" }); }, { name: "TypeError", message: "box environment update has an invalid shape" });
    assert.throws(() => { void inner.applyEnvironment?.(context, null); }, { name: "TypeError", message: "box environment update must be an object" });
    assert.throws(() => { void inner.applyEnvironment?.(context, []); }, { name: "TypeError", message: "box environment update must be an object" });
    assert.deepEqual(ports.controlCalls, []);
  });

  it("hands a file to the box in one piece, and stands the box's own accessor in front of what it reaches", async () => {
    const ports = generatedPorts();
    const inner = createProductionBoxInner(options(ports.generated, false));
    const context = createContext().withName("box");
    const ready = await inner.ensureReady(context, "agent-1") as { vncUrl: string; remoteAccessor?: unknown; terminalsFolder?: string };
    // The standalone box has no desktop of its own to offer, and takes the monitor-free accessor instead.
    const accessor = ready.remoteAccessor as unknown as { noMonitor?: boolean; wrapped?: boolean };
    assert.deepEqual({ vncUrl: ready.vncUrl, noMonitor: accessor.noMonitor, built: accessor.wrapped }, { vncUrl: "", noMonitor: true, built: true });
    assert.equal(ready.terminalsFolder, "/root/.slate/projects/workspace/terminals");
    await inner.uploadFile(context, "agent-1", "/root/notes/today.txt", new TextEncoder().encode("hello"));
    // The file is written beside its name and then moved into place, so a reader never sees half of it.
    // The directory is made first, with the path quoted for the shell it runs in.
    assert.equal(ports.shells[0]?.startsWith("bash -lc "), true);
    assert.equal(ports.shells[0]?.includes("mkdir -p --"), true);
    assert.equal(ports.shells[0]?.includes("/root/notes"), true);
    assert.equal(ports.writes.length, 1);
    assert.equal(ports.writes[0]?.bytes, 5);
    assert.equal(ports.writes[0]?.path.startsWith("/root/notes/today.txt.slate-"), true);
    assert.equal(ports.writes[0]?.path.endsWith(".part"), true);
    assert.equal(ports.shells[1]?.includes("mv -f --"), true);
    assert.equal(ports.shells[1]?.includes(String(ports.writes[0]?.path)), true);
    assert.equal(ports.shells[1]?.includes("/root/notes/today.txt"), true);
    assert.equal(await inner.releaseWindow?.(context, "agent-1"), undefined);
    assert.equal(await inner.dispose(), undefined);
  });

  it("offers the box's own desktop when the build has one, and nothing of that when it does not", async () => {
    const context = createContext().withName("box");
    const composedPorts = generatedPorts();
    const composed = createProductionBoxInner(options(composedPorts.generated));
    const composedReady = await composed.ensureReady(context, "agent-1") as { vncUrl: string; terminalsFolder?: string };
    // With the box's own image, a window is reached through it, and its accessor is the box's own.
    assert.equal(composedReady.vncUrl.startsWith("http://127.0.0.1:6081/vnc.html?path="), true);
    assert.equal(composedReady.terminalsFolder, "/root/.slate/projects/workspace/terminals");
    const standalonePorts = generatedPorts();
    const standalone = createProductionBoxInner(options(standalonePorts.generated, false));
    assert.equal((await standalone.ensureReady(context, "agent-1")).vncUrl, "");
  });
});
