/**
 * One path's worth of synchronisation work.
 *
 * The request names what to push or pull, carries the digest it expects, and is written under the store's own sync
 * directory so a half-written request is never read; what comes back says whether the store's copy still matches.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { AGENT_STORE_SYNC_DIR_NAME, ensureSecureDirectoryChain } from "./paths.ts";
import { writeLockFileExclusive } from "./secure-open.ts";
import { normalizeRelPath } from "./safe-paths.ts";

/** The directory under the store's sync directory that holds path-sync requests. */
const REQUESTS_DIR_NAME = "path-sync-requests";

/** How old a request may be before it is treated as abandoned. */
const REQUEST_STALE_MS = 60_000;

/** How often a caller listing for work should look, and how often a waiting caller should. */
export const PATH_SYNC_REQUEST_POLL_MS = 250;
export const PATH_SYNC_REQUEST_WAIT_POLL_MS = 50;

/** The mode a request file is created with. */
const REQUEST_FILE_MODE = 0o600;

/** The version a request must name to be read. */
const REQUEST_VERSION = 1;

/** The ids that can be acknowledged: the hex a request is named under. */
const REQUEST_ID_PATTERN = /^[0-9a-f]+$/i;

/** What one request says: what to synchronise and when it was asked for. */
interface PathSyncRequest {
  readonly v: typeof REQUEST_VERSION;
  readonly id: string;
  readonly relPaths: string[];
  readonly createdAtMs: number;
}

/** What listing or inspecting a store's requests needs from the caller. */
interface PathSyncRequestArgs {
  readonly filesDir: string;
  readonly now?: () => number;
  readonly staleMs?: number;
}

/** How one request stands: it is done, it is still there, or it is not worth waiting for. */
type PathSyncRequestPresence = "acked" | "pending" | "stale";

/** What reading one request file found: the request, or that the file is gone, unreadable or no longer a request. */
type RequestFileState =
  | { readonly request: PathSyncRequest }
  | { readonly state: "unreadable" }
  | { readonly state: "dropped" };

/** The directory the store keeps its path-sync requests in. */
function requestsDirFor(filesDir: string): string {
  return path.join(path.dirname(path.resolve(filesDir)), AGENT_STORE_SYNC_DIR_NAME, REQUESTS_DIR_NAME);
}

/** The file one request is written to. */
function requestFileFor(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

/** Removes a file that is no longer a request worth keeping, without caring whether it was there. */
function removeFileQuietly(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
  }
}

/** The canonical form of a set of paths, or nothing when one of them is not a path; duplicates collapse. */
function canonicalRelPaths(relPaths: readonly unknown[]): string[] | undefined {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of relPaths) {
    let canonical: string;
    try {
      canonical = normalizeRelPath(raw);
    } catch {
      return undefined;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

/** The body one request is written as. */
function requestBody(id: string, relPaths: readonly string[], createdAtMs: number): PathSyncRequest {
  return { v: REQUEST_VERSION, id, relPaths: [...relPaths], createdAtMs };
}

/** A parsed request, when the parsed value is one this version can read. */
function requestFromRecord(record: { readonly v?: unknown; readonly id?: unknown; readonly relPaths?: unknown; readonly createdAtMs?: unknown }): PathSyncRequest | undefined {
  if (record.v !== REQUEST_VERSION) return undefined;
  if (typeof record.id !== "string" || record.id.length === 0) return undefined;
  if (!Array.isArray(record.relPaths)) return undefined;
  if (typeof record.createdAtMs !== "number" || !Number.isFinite(record.createdAtMs)) return undefined;
  const relPaths = canonicalRelPaths(record.relPaths.filter(value => typeof value === "string"));
  if (relPaths === undefined || relPaths.length === 0) return undefined;
  return { v: REQUEST_VERSION, id: record.id, relPaths, createdAtMs: record.createdAtMs };
}

/** The request a file's contents are, when they still describe one. */
function parseRequest(raw: string): PathSyncRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  return requestFromRecord(parsed as { readonly v?: unknown; readonly id?: unknown; readonly relPaths?: unknown; readonly createdAtMs?: unknown });
}

/** Whether a request has aged past the point where it is worth acting on. */
function isStale(request: PathSyncRequest, now: number, staleMs: number): boolean {
  return now - request.createdAtMs > staleMs;
}

/** Reads the request file at a path, reporting whether it is gone, unreadable, no longer a request or stale. */
function readRequestFile(file: string, now: number, staleMs: number): RequestFileState {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return { state: "unreadable" };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    removeFileQuietly(file);
    return { state: "dropped" };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { state: "unreadable" };
  }
  const request = parseRequest(raw);
  if (request === undefined || isStale(request, now, staleMs)) {
    removeFileQuietly(file);
    return { state: "dropped" };
  }
  return { request };
}

/** Asks the store to synchronise a set of paths, answering with the id the request was written under. */
export async function enqueuePathSyncRequest(args: { readonly filesDir: string; readonly relPaths: readonly unknown[]; readonly now?: () => number }): Promise<string | undefined> {
  const relPaths = canonicalRelPaths(args.relPaths);
  if (relPaths === undefined || relPaths.length === 0) return undefined;
  const dir = requestsDirFor(args.filesDir);
  try {
    ensureSecureDirectoryChain(dir);
  } catch {
    return undefined;
  }
  const id = crypto.randomBytes(16).toString("hex");
  const target = requestFileFor(dir, id);
  try {
    await writeLockFileExclusive(target, `${JSON.stringify(requestBody(id, relPaths, (args.now ?? Date.now)()))}\n`, REQUEST_FILE_MODE);
  } catch {
    return undefined;
  }
  return id;
}

/** The requests the store has not answered yet, leaving out and cleaning up the ones that can no longer be read. */
export function listPathSyncRequests(args: PathSyncRequestArgs): PathSyncRequest[] {
  const dir = requestsDirFor(args.filesDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const now = (args.now ?? Date.now)();
  const staleMs = args.staleMs ?? REQUEST_STALE_MS;
  const out: PathSyncRequest[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const read = readRequestFile(path.join(dir, name), now, staleMs);
    if ("request" in read) out.push(read.request);
  }
  return out;
}

/** Where one request stands, from the file the store keeps for it. */
function inspectPathSyncRequest(args: PathSyncRequestArgs & { readonly requestId: string }): PathSyncRequestPresence {
  const dir = requestsDirFor(args.filesDir);
  const file = requestFileFor(dir, args.requestId);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return code === "ENOENT" ? "acked" : "pending";
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    removeFileQuietly(file);
    return "stale";
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return "pending";
  }
  const request = parseRequest(raw);
  if (request === undefined) {
    removeFileQuietly(file);
    return "stale";
  }
  const now = (args.now ?? Date.now)();
  const staleMs = args.staleMs ?? REQUEST_STALE_MS;
  if (isStale(request, now, staleMs)) {
    removeFileQuietly(file);
    return "stale";
  }
  return "pending";
}

/** Acknowledges requests by deleting their files; ids that are not request ids are left alone. */
export function ackPathSyncRequests(args: { readonly filesDir: string; readonly requestIds: readonly string[] }): void {
  const dir = requestsDirFor(args.filesDir);
  for (const id of args.requestIds) {
    if (!REQUEST_ID_PATTERN.test(id)) continue;
    removeFileQuietly(requestFileFor(dir, id));
  }
}

/** The wait a polling caller takes between looks when it does not say. */
function defaultDelay(ms: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

/** Waits for a request to be acknowledged, to go stale, or for the caller to give up. */
export async function waitForPathSyncRequestAck(args: {
  readonly filesDir: string;
  readonly requestId: string;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly staleMs?: number;
  readonly shouldAbort?: () => boolean;
  readonly delay?: (ms: number) => Promise<unknown>;
}): Promise<"acked" | "stale" | "aborted"> {
  const pollMs = args.pollMs ?? PATH_SYNC_REQUEST_WAIT_POLL_MS;
  const delay = args.delay ?? defaultDelay;
  for (;;) {
    const presence = inspectPathSyncRequest(args);
    if (presence !== "pending") return presence;
    if (args.shouldAbort?.() === true) return "aborted";
    await delay(pollMs);
  }
}
