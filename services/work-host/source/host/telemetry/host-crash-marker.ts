/** The mark the host leaves behind while it is running.

 * A file the host touches as it starts and removes as it stops; finding one at startup means the host before it died
 * without saying so, which is worth telling the user and the platform rather than passing over. */
import { readFile as readTextFile, rm as removeFile } from "node:fs/promises";
import { getHostCrashMarkerPath } from "../host-paths.ts";

export const HOST_CRASH_EXIT_SIGNALS = [
  "none",
  "unknown",
  "other",
  "SIGABRT",
  "SIGALRM",
  "SIGBUS",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGKILL",
  "SIGPIPE",
  "SIGQUIT",
  "SIGSEGV",
  "SIGTERM",
  "SIGTRAP",
  "SIGUSR1",
  "SIGUSR2",
  "SIGXCPU",
  "SIGXFSZ",
] as const;
export type HostCrashMarker = {
  schemaVersion: 1;
  errorClass:
    | "signal_exit"
    | "nonzero_exit"
    | "unexpected_clean_exit"
    | "unobserved_exit";
  exitSignal: string;
  crashedAtMs: number;
  startedAtMs?: number;
  uptimeMs?: number;
};
export type HostCrashMarkerRead =
  | { kind: "present"; raw: string }
  | { kind: "absent" }
  | { kind: "unavailable" };
export interface HostCrashMarkerStore {
  read(): Promise<HostCrashMarkerRead>;
  delete(): Promise<"deleted" | "unavailable">;
}
export function isNonNegativeFinite(body: unknown): body is number {
  return typeof body === "number" && Number.isFinite(body) && body >= 0;
}
export function isFatalExitSignal(body: unknown): body is string {
  return (
    typeof body === "string" &&
    body !== "none" &&
    body !== "unknown" &&
    HOST_CRASH_EXIT_SIGNALS.some((candidateSignal) => candidateSignal === body)
  );
}
export function readCommonTimes(
  body: Record<string, unknown>,
): { startedAtMs: number; crashedAtMs: number; uptimeMs: number } | null {
  if (
    !("startedAtMs" in body) ||
    !("crashedAtMs" in body) ||
    !("uptimeMs" in body) ||
    !isNonNegativeFinite(body.startedAtMs) ||
    !isNonNegativeFinite(body.crashedAtMs) ||
    !isNonNegativeFinite(body.uptimeMs)
  )
    return null;
  return {
    startedAtMs: body.startedAtMs,
    crashedAtMs: body.crashedAtMs,
    uptimeMs: body.uptimeMs,
  };
}
export function parseJson(
  markerText: string,
): { kind: "parsed"; value: unknown } | { kind: "invalid" } {
  try {
    return { kind: "parsed", value: JSON.parse(markerText) };
  } catch {
    return { kind: "invalid" };
  }
}
export function parseHostCrashMarker(markerText: string): HostCrashMarker | null {
  const parsedJson = parseJson(markerText);
  if (parsedJson.kind === "invalid") return null;
  const { value: body } = parsedJson;
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return null;
  const v = body as Record<string, unknown>;
  if (v.schemaVersion !== 1 || !("errorClass" in v) || !("exitSignal" in v))
    return null;
  if (v.errorClass === "signal_exit" && isFatalExitSignal(v.exitSignal)) {
    const commonTimes = readCommonTimes(v);
    return commonTimes === null
      ? null
      : {
          schemaVersion: 1,
          errorClass: v.errorClass,
          exitSignal: v.exitSignal,
          ...commonTimes,
        };
  }
  if (
    (v.errorClass === "nonzero_exit" ||
      v.errorClass === "unexpected_clean_exit") &&
    v.exitSignal === "none"
  ) {
    const commonTimes = readCommonTimes(v);
    return commonTimes === null
      ? null
      : {
          schemaVersion: 1,
          errorClass: v.errorClass,
          exitSignal: v.exitSignal,
          ...commonTimes,
        };
  }
  if (
    v.errorClass !== "unobserved_exit" ||
    v.exitSignal !== "unknown" ||
    !isNonNegativeFinite(v.crashedAtMs)
  )
    return null;
  const startedAtMs = v.startedAtMs,
    uptimeMs = v.uptimeMs;
  if (
    (startedAtMs !== undefined && !isNonNegativeFinite(startedAtMs)) ||
    (uptimeMs !== undefined && !isNonNegativeFinite(uptimeMs))
  )
    return null;
  return {
    schemaVersion: 1,
    errorClass: v.errorClass,
    exitSignal: v.exitSignal,
    ...(startedAtMs === undefined
      ? {}
      : { startedAtMs: startedAtMs as number }),
    crashedAtMs: v.crashedAtMs,
    ...(uptimeMs === undefined ? {} : { uptimeMs: uptimeMs as number }),
  };
}
export function hostCrashMarkerMetadata(parsedMarker: HostCrashMarker) {
  return {
    kind: "process_exit",
    error_class: parsedMarker.errorClass,
    exit_signal: parsedMarker.exitSignal,
    ...(parsedMarker.startedAtMs === undefined
      ? {}
      : { started_at_ms: String(Math.round(parsedMarker.startedAtMs)) }),
    crashed_at_ms: String(Math.round(parsedMarker.crashedAtMs)),
    ...(parsedMarker.uptimeMs === undefined
      ? {}
      : { uptime_ms: String(Math.round(parsedMarker.uptimeMs)) }),
  };
}
export function createHostCrashMarkerStore(
  markerPath = getHostCrashMarkerPath(),
): HostCrashMarkerStore {
  return {
    read: async () => {
      try {
        return { kind: "present", raw: await readTextFile(markerPath, "utf8") };
      } catch (cause) {
        if (
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "ENOENT"
        )
          return { kind: "absent" };
        return { kind: "unavailable" };
      }
    },
    delete: async () => {
      try {
        await removeFile(markerPath, { force: true });
        return "deleted";
      } catch {
        return "unavailable";
      }
    },
  };
}
export async function deleteIfUnchanged(
  markerStore: HostCrashMarkerStore,
  markerText: string,
): Promise<"failed" | "deleted" | "changed"> {
  const current = await markerStore.read();
  if (current.kind === "unavailable") return "failed";
  if (current.kind === "absent") return "deleted";
  if (current.raw !== markerText) return "changed";
  return (await markerStore.delete()) === "deleted" ? "deleted" : "failed";
}
export async function forwardHostCrashMarkerWith(forwarding: {
  store: HostCrashMarkerStore;
  wasForwarded(markerText: string): boolean;
  markForwarded(markerText: string): void;
  emit(parsedMarker: HostCrashMarker): Promise<boolean>;
}): Promise<
  | "deferred"
  | "absent"
  | "delete_deferred"
  | "pending"
  | "delivered"
  | "parse_error"
> {
  const currentRead = await forwarding.store.read();
  if (currentRead.kind === "unavailable") return "deferred";
  if (currentRead.kind === "absent") return "absent";
  const { raw: markerText } = currentRead;
  if (forwarding.wasForwarded(markerText)) {
    const removal = await deleteIfUnchanged(forwarding.store, markerText);
    if (removal === "failed") return "delete_deferred";
    return removal === "changed" ? "pending" : "delivered";
  }
  const parsedMarker = parseHostCrashMarker(markerText);
  if (parsedMarker === null) {
    forwarding.markForwarded(markerText);
    const removal = await deleteIfUnchanged(forwarding.store, markerText);
    if (removal === "failed") return "delete_deferred";
    return removal === "changed" ? "pending" : "parse_error";
  }
  if (!(await forwarding.emit(parsedMarker))) return "deferred";
  forwarding.markForwarded(markerText);
  const removal = await deleteIfUnchanged(forwarding.store, markerText);
  if (removal === "failed") return "delete_deferred";
  return removal === "changed" ? "pending" : "delivered";
}
