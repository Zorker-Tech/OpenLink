/** Shared state comparisons and failure reporting for maintenance passes. */
import { basename, dirname, resolve } from "node:path";
import type { MaintenanceHost } from "./session-maintenance-contracts.ts";

export function blobIdHex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

export function generationAt(host: MaintenanceHost, path: string): number {
  return host.writeGeneration?.(path) ?? 0;
}

export function openHandles(host: MaintenanceHost, path: string): number {
  return host.liveHandleCount?.(resolve(path)) ?? 1;
}

export function reportMaintenanceFailure(host: MaintenanceHost, kind: string, dbPath: string, error?: unknown): void {
  host.report?.({
    family: "maintenance",
    kind,
    agentId: basename(dirname(dbPath)),
    ...(error == null ? {} : { errorClass: error instanceof Error ? error.name : String(error) }),
  });
}
