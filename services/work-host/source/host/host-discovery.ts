/**
 * The file that says where a host is listening.
 *
 * It is written atomically the moment the gateway is up — port, process, when it started and how it is reached — so a
 * client that finds it can connect without being told anything else, and it is removed when the host goes away.
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getGatewayDiscoveryPath } from "./host-paths.ts";

export interface GatewayDiscoveryInfo {
  readonly port: number;
  readonly pid: number;
  readonly startedAt: number;
  readonly scheme?: "http" | "https";
  readonly host?: string;
  readonly token?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export function isGatewayDiscoveryInfo(value: unknown): value is GatewayDiscoveryInfo {
  if (!isRecord(value)) return false;
  if (!isPositiveInteger(value.port) || !isPositiveInteger(value.pid)) return false;
  if (typeof value.startedAt !== "number") return false;

  const supportedScheme = value.scheme === undefined || value.scheme === "http" || value.scheme === "https";
  return supportedScheme && isOptionalText(value.host) && isOptionalText(value.token);
}

export async function writeGatewayDiscovery(
  info: GatewayDiscoveryInfo,
  discoveryPath = getGatewayDiscoveryPath(),
): Promise<void> {
  if (!isGatewayDiscoveryInfo(info)) throw new TypeError("invalid gateway discovery info");

  await mkdir(dirname(discoveryPath), { recursive: true });
  const stagedPath = `${discoveryPath}.${process.pid}.tmp`;
  const serialized = JSON.stringify(info, null, 2);
  await writeFile(stagedPath, serialized, "utf8");
  await rename(stagedPath, discoveryPath);
}

export async function clearGatewayDiscovery(discoveryPath = getGatewayDiscoveryPath()): Promise<void> {
  await rm(discoveryPath, { force: true });
}
