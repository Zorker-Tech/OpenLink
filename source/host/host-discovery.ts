/**
 * The file that says where a host is listening.
 *
 * It is written atomically the moment the gateway is up — port, process, when it started and how it is reached — so a
 * client that finds it can connect without being told anything else, and it is removed when the host goes away.
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getGatewayDiscoveryPath } from "./host-paths.ts";
export interface GatewayDiscoveryInfo { readonly port: number; readonly pid: number; readonly startedAt: number; readonly scheme?: "http" | "https"; readonly host?: string; readonly token?: string; }
export function isGatewayDiscoveryInfo(value: unknown): value is GatewayDiscoveryInfo { if (typeof value !== "object" || value == null || Array.isArray(value)) return false; const v = value as Record<string, unknown>; return typeof v.port === "number" && Number.isInteger(v.port) && v.port > 0 && typeof v.pid === "number" && Number.isInteger(v.pid) && v.pid > 0 && typeof v.startedAt === "number" && (v.scheme === undefined || v.scheme === "http" || v.scheme === "https") && (v.host === undefined || typeof v.host === "string") && (v.token === undefined || typeof v.token === "string"); }
export async function writeGatewayDiscovery(info: GatewayDiscoveryInfo, path = getGatewayDiscoveryPath()): Promise<void> { if (!isGatewayDiscoveryInfo(info)) throw new TypeError("invalid gateway discovery info"); await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(info, null, 2), "utf8"); await rename(temp, path); }
export async function clearGatewayDiscovery(path = getGatewayDiscoveryPath()): Promise<void> { await rm(path, { force: true }); }
