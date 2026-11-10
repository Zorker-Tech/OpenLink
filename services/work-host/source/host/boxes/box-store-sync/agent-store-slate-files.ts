/**
 * The box's own view of the agent store: one object at a time, over the urls the store presigns.
 *
 * What a box does with the store is read, write and list single objects, and the rules this file owns are the ones that
 * keep that safe and predictable:
 *
 * - **where it will talk to**: a presigned url is only used when it is https (or plain http on loopback while the
 *   backend itself is on loopback), carries no credentials, and names one of the store's own buckets;
 * - **what a path may be**: a relative path is normalized into parts and refused when it is empty, absolute, walks
 *   up, is longer than a filesystem segment allows, carries a control character, ends in a dot or a space, or uses a
 *   device name Windows reserves;
 * - **what it remembers between writes**: the etag a write answered with is kept, so the next write of the same file
 *   is presigned against it instead of probing for it; a write the store would not take forgets it again, and so does
 *   a write that answered with no etag at all;
 * - **what a collision means**: a write that collided on the object store is tried once more, and if the store still
 *   refuses, the local copy is kept aside under the conflict's own name — the box's work is never lost to a race.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path, { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BcsAgentStoreTransport } from "../../../packages/agent-store-sync/bcs-transport.ts";
import { AGENT_STORE_SYNC_CLIENT_CONFIG_DEFAULTS } from "../../../packages/agent-store-sync/sync-client-config.ts";
import { TokenCachingAgentStoreClient } from "../../../packages/agent-store-sync/token-caching-client.ts";
import { normalizeS3Etag } from "../../../packages/agent-store-sync/etag.ts";
import { createSlateBackendTransport, getSlateInferenceBackendUrl } from "../../../adapters/interop/slate-backend/slate-backend-client.ts";
import { isSlatePlaygroundBackend } from "../../../adapters/interop/slate-backend/backend-host-policy.ts";
import { sha256Hex } from "../../sha256.ts";
import { reportBoxStoreDiagnostic } from "./box-store-diagnostics.ts";
import { BoxStoreSyncError } from "./box-store-sync-error.ts";

export interface AgentStoreWriteFile {
  readonly relPath: string;
  readonly sha: string;
  readonly size: number;
  readonly baseEtag?: string;
  readonly expectAbsent?: boolean;
}

export interface AgentStoreConflictWriteInstruction {
  readonly relPath: string;
  readonly url: string;
  readonly headers?: Record<string, string>;
}

export interface AgentStoreWriteInstruction {
  readonly relPath: string;
  readonly url: string;
  readonly sha: string;
  readonly headers?: Record<string, string>;
  readonly conflict?: AgentStoreConflictWriteInstruction;
}

export interface AgentStoreReadInstruction {
  readonly relPath: string;
  readonly url: string;
  readonly expiresAtMs: number;
}

export interface AgentStoreClient {
  presignWrites(args: { readonly agentId: string; readonly files: readonly AgentStoreWriteFile[] }): Promise<readonly AgentStoreWriteInstruction[]>;
  presignReads(args: { readonly agentId: string; readonly relPaths: readonly string[]; readonly signal?: AbortSignal }): Promise<readonly AgentStoreReadInstruction[]>;
  listFiles(args: { readonly agentId: string; readonly relPath: string }): Promise<{ readonly files: readonly { readonly relPath: string }[] }>;
  invalidateListCache?(args: { readonly agentId: string }): void;
}

export interface AgentStoreClientDependencies {
  readonly client?: AgentStoreClient;
  readonly getAccessToken?: (...args: unknown[]) => unknown;
  readonly getMachineId?: (...args: unknown[]) => unknown;
}

/** The store's client as the box uses it: the one it was given, or one over the backend's own transport. */
export function createAgentStoreClient(deps: AgentStoreClientDependencies): AgentStoreClient {
  if (deps.client !== undefined) return deps.client;
  const transport = new BcsAgentStoreTransport({
    transport: createSlateBackendTransport({
      getAccessToken: deps.getAccessToken! as (options: { backendUrl: string }) => Promise<string>,
      getMachineId: deps.getMachineId! as () => Promise<string> | string,
    }),
    rpcTimeoutMs: AGENT_STORE_SYNC_CLIENT_CONFIG_DEFAULTS.rpcTimeoutMs,
  });
  return new TokenCachingAgentStoreClient(transport, {}) as unknown as AgentStoreClient;
}

/** What this session knows about the files it has written: the etag each one answered with last. */
export class AgentStoreMutableWriteEtags {
  private readonly etags = new Map<string, string>();

  get(sourceId: string, relPath: string): string | undefined {
    return this.etags.get(`${sourceId}\0${relPath}`);
  }

  set(sourceId: string, relPath: string, etag: string): void {
    this.etags.set(`${sourceId}\0${relPath}`, etag);
  }

  delete(sourceId: string, relPath: string): void {
    this.etags.delete(`${sourceId}\0${relPath}`);
  }
}

/** What a write is presigned against, and where that came from. */
interface MutableWriteBaseline {
  readonly precondition: { readonly baseEtag: string } | { readonly expectAbsent: true };
  readonly source: "session" | "probe" | "absent";
}

const BCS_AGENT_STORE_BUCKET_HOSTS = new Set(["agent-stores.s3.us-east-1.amazonaws.com", "agent-stores.s3.amazonaws.com"]);
const PLAYGROUND_AGENT_STORE_BUCKET_HOSTS = new Set(["agent-stores-928182716709-us-west-2-an.s3.us-west-2.amazonaws.com", "agent-stores-928182716709-us-west-2-an.s3.amazonaws.com"]);
/** Names Windows reserves for devices, which a file the store holds may never be called. */
const WINDOWS_RESERVED = new Set(["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"]);

/** A path the store can hold, or the reason it cannot. */
function normalizePath(relPath: string): string {
  if (relPath.length === 0) throw new Error("Agent store relative path must be a non-empty string");
  if (relPath.includes("\0")) throw new Error("Agent store relative path must not contain NUL bytes");
  if (path.posix.isAbsolute(relPath) || path.win32.isAbsolute(relPath)) throw new Error(`Agent store relative path must not be absolute: ${relPath}`);
  const parts: string[] = [];
  for (const segment of relPath.replaceAll("\\", "/").split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") throw new Error(`Agent store relative path must not contain '..': ${relPath}`);
    if (Buffer.byteLength(segment, "utf8") > 255) throw new Error(`Agent store path segment exceeds 255 bytes: ${segment}`);
    for (let index = 0; index < segment.length; index += 1) {
      const code = segment.charCodeAt(index);
      if (code < 32 || code === 127) throw new Error(`Agent store path segment contains control character (0x${code.toString(16)}): ${segment}`);
    }
    const lastChar = segment.at(-1);
    // Windows trims a trailing dot or space, so a name that has one means two different files on two systems.
    if (lastChar === "." || lastChar === " ") throw new Error(`Agent store path segment must not end with '.' or space (Windows trims these): ${segment}`);
    const deviceStem = segment.toLowerCase().split(".")[0];
    if (deviceStem !== undefined && WINDOWS_RESERVED.has(deviceStem)) throw new Error(`Agent store path segment uses a reserved device name: ${segment}`);
    parts.push(segment);
  }
  if (parts.length === 0) throw new Error(`Agent store relative path resolved to empty: ${relPath}`);
  return parts.join("/");
}

function isLoopback(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower === "ip6-localhost" || lower === "127.0.0.1" || lower === "::1" || lower === "0:0:0:0:0:0:0:1";
}

/** Where this box will send a presigned request: https on the store's own buckets, or plain http on loopback in dev. */
function validateUrl(raw: string, relPath: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Refusing unparseable presigned URL for ${relPath}`);
  }
  if (url.username !== "" || url.password !== "") throw new Error(`Refusing presigned URL for ${relPath}: Refused presigned URL with embedded userinfo`);
  const backend = getSlateInferenceBackendUrl();
  if ((backend.includes("localhost") || backend.includes("lclhst.build")) && url.protocol === "http:" && isLoopback(url.hostname)) return;
  if (url.protocol !== "https:") throw new Error(`Refusing presigned URL for ${relPath}: Refused presigned URL with non-https scheme: ${url.protocol}`);
  const playground = isSlatePlaygroundBackend(backend);
  const allowed = playground ? PLAYGROUND_AGENT_STORE_BUCKET_HOSTS : BCS_AGENT_STORE_BUCKET_HOSTS;
  if (!allowed.has(url.hostname.toLowerCase())) throw new Error(`Refusing presigned URL for ${relPath}: Refused presigned URL whose host is not in the allowlist: ${url.hostname}`);
}

/** Whether the store already holds an object, and what its etag is. */
async function probeObject(client: AgentStoreClient, sourceId: string, relPath: string): Promise<{ readonly kind: "absent" } | { readonly kind: "exists"; readonly etag: string }> {
  const [instruction] = await client.presignReads({ agentId: sourceId, relPaths: [relPath] });
  if (instruction === undefined) throw new Error(`agent-store baseline probe returned no read for ${relPath}`);
  let requestedPath: string;
  let presignPath: string;
  try {
    requestedPath = normalizePath(relPath);
    presignPath = normalizePath(instruction.relPath);
  } catch (error) {
    throw new Error(`agent-store baseline probe relPath mismatch for ${relPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (presignPath !== requestedPath) throw new Error(`agent-store baseline probe relPath mismatch for ${relPath} (got ${instruction.relPath})`);
  validateUrl(instruction.url, relPath);
  // One byte is enough to learn the etag; an empty object refuses the range, so it is asked for whole then.
  const lookup = (range: boolean) => fetch(instruction.url, { redirect: "error", ...(range ? { headers: { Range: "bytes=0-0" } } : {}) });
  let reply = await lookup(true);
  if (reply.status === 416) {
    await reply.body?.cancel();
    reply = await lookup(false);
  }
  try {
    if (reply.status === 404) return { kind: "absent" };
    if (reply.status !== 200 && reply.status !== 206) throw new Error(`agent-store baseline probe failed for ${relPath}: ${reply.status}`);
    const etag = normalizeS3Etag(reply.headers.get("etag") ?? undefined);
    if (etag.length === 0) throw new Error(`agent-store baseline probe for ${relPath} returned no usable etag`);
    return { kind: "exists", etag };
  } finally {
    await reply.body?.cancel();
  }
}

async function presignWrite(client: AgentStoreClient, sourceId: string, file: Omit<AgentStoreWriteFile, "baseEtag" | "expectAbsent">, precondition: { readonly baseEtag: string } | { readonly expectAbsent: true }): Promise<AgentStoreWriteInstruction> {
  const [instruction] = await client.presignWrites({ agentId: sourceId, files: [{ ...file, ...precondition }] });
  if (instruction === undefined) throw new BoxStoreSyncError(`agent-store presign returned no write for ${file.relPath}`);
  return instruction;
}

function hasConditionalHeaders(instruction: AgentStoreWriteInstruction): boolean {
  return Object.keys(instruction.headers ?? {}).some((name) => {
    const key = name.toLowerCase();
    return key === "if-match" || key === "if-none-match";
  });
}

/** A write that is protected against conflicts one way but not the other is worth saying out loud. */
function warnDowngraded(instruction: AgentStoreWriteInstruction): void {
  if (instruction.conflict !== undefined || hasConditionalHeaders(instruction)) return;
  reportBoxStoreDiagnostic({ extension: "box_store", kind: "conflict_protection_downgraded" });
}

/** What the object store is told about the body when the store instruction no headers of its own. */
function putHeaders(instruction: AgentStoreWriteInstruction): Record<string, string> {
  return instruction.headers !== undefined ? { ...instruction.headers } : { "x-amz-meta-content-sha256": instruction.sha };
}

export function isConditionalWriteRejection(code: number): boolean {
  return code === 412 || code === 409;
}

/** What the write is presigned against: what this session knows, or what a lookup of the store found. */
async function resolveBaseline(client: AgentStoreClient, sourceId: string, relPath: string, etags: AgentStoreMutableWriteEtags): Promise<MutableWriteBaseline> {
  const remembered = etags.get(sourceId, relPath);
  if (remembered !== undefined) return { precondition: { baseEtag: remembered }, source: "session" };
  const lookup = await probeObject(client, sourceId, relPath);
  return lookup.kind === "absent" ? { precondition: { expectAbsent: true }, source: "absent" } : { precondition: { baseEtag: lookup.etag }, source: "probe" };
}

/** The local copy of a file that collided: written beside the store's own object rather than lost. */
async function putConflict(client: AgentStoreClient, sourceId: string, file: Omit<AgentStoreWriteFile, "baseEtag" | "expectAbsent">, precondition: { readonly baseEtag: string } | { readonly expectAbsent: true }, conflict: AgentStoreConflictWriteInstruction, data: Uint8Array): Promise<string> {
  let target = conflict;
  let reply = await fetch(target.url, { method: "PUT", headers: { ...(target.headers ?? {}) }, body: Buffer.from(data) });
  if (isConditionalWriteRejection(reply.status)) {
    const fresh = await presignWrite(client, sourceId, file, precondition);
    if (fresh.conflict === undefined) throw new BoxStoreSyncError(`agent-store conflict write for ${file.relPath} collided and the fresh presign returned no conflict instruction`);
    target = fresh.conflict;
    reply = await fetch(target.url, { method: "PUT", headers: { ...(target.headers ?? {}) }, body: Buffer.from(data) });
  }
  if (!reply.ok) throw new BoxStoreSyncError(`agent-store conflict write failed for ${file.relPath} -> ${target.relPath}: ${reply.status}`);
  return target.relPath;
}

export async function putAgentStoreObject(args: {
  readonly client: AgentStoreClient;
  readonly sourceId: string;
  readonly relPath: string;
  readonly data: Uint8Array;
  readonly etags: AgentStoreMutableWriteEtags;
}): Promise<
  | { readonly outcome: "written" }
  | {
      readonly outcome: "conflict";
      readonly conflictRelPath: string;
      readonly baseEtag: string | null;
      readonly baselineSource: "session" | "probe" | "absent";
    }
> {
  const { client, sourceId, relPath, data, etags } = args;
  const file = { relPath, sha: sha256Hex(data), size: data.byteLength };
  const { precondition, source: baseline } = await resolveBaseline(client, sourceId, relPath, etags);
  const instruction = await presignWrite(client, sourceId, file, precondition);
  if (instruction.conflict === undefined && hasConditionalHeaders(instruction)) throw new BoxStoreSyncError(`agent-store presign for ${relPath} carries a conditional header but no conflict instruction`);
  warnDowngraded(instruction);
  const put = () => fetch(instruction.url, { method: "PUT", headers: putHeaders(instruction), body: Buffer.from(data) });
  let reply = await put();
  // A collision on the object store itself is worth one more try before the copy is kept aside.
  if (reply.status === 409) reply = await put();
  if (isConditionalWriteRejection(reply.status)) {
    etags.delete(sourceId, relPath);
    client.invalidateListCache?.({ agentId: sourceId });
    if (instruction.conflict === undefined) throw new BoxStoreSyncError(`agent-store write failed for ${relPath}: ${reply.status}`);
    const conflictRelPath = await putConflict(client, sourceId, file, precondition, instruction.conflict, data);
    reportBoxStoreDiagnostic({ extension: "box_store", kind: "write_conflict_preserved" });
    return { outcome: "conflict", conflictRelPath, baseEtag: "baseEtag" in precondition ? precondition.baseEtag : null, baselineSource: baseline };
  }
  if (!reply.ok) throw new BoxStoreSyncError(`agent-store write failed for ${relPath}: ${reply.status}`);
  const etag = normalizeS3Etag(reply.headers.get("etag") ?? undefined);
  // Without an etag there is nothing to write against next time, so what was remembered is dropped and the listing too.
  if (etag.length > 0) etags.set(sourceId, relPath, etag);
  else {
    etags.delete(sourceId, relPath);
    client.invalidateListCache?.({ agentId: sourceId });
  }
  return { outcome: "written" };
}

/** A write that is only made when the object is not there at all, which is what a content-addressed file wants. */
export async function putAgentStoreObjectContentAddressed(args: { readonly client: AgentStoreClient; readonly sourceId: string; readonly relPath: string; readonly data: Uint8Array }): Promise<void> {
  const { client, sourceId, relPath, data } = args;
  const instruction = await presignWrite(client, sourceId, { relPath, sha: sha256Hex(data), size: data.byteLength }, { expectAbsent: true });
  warnDowngraded(instruction);
  const put = () => fetch(instruction.url, { method: "PUT", headers: putHeaders(instruction), body: Buffer.from(data) });
  let reply = await put();
  if (reply.status === 409) reply = await put();
  // The store refusing because the object is already there is exactly what this write was for.
  if (reply.status === 412) return;
  if (!reply.ok) throw new BoxStoreSyncError(`agent-store write failed for ${relPath}: ${reply.status}`);
}

export async function getAgentStoreObject(client: AgentStoreClient, sourceId: string, relPath: string): Promise<Uint8Array | null> {
  const [instruction] = await client.presignReads({ agentId: sourceId, relPaths: [relPath] });
  return instruction === undefined ? null : fetchAgentStoreObjectFromUrl(instruction.url, relPath);
}

export async function fetchAgentStoreObjectFromUrl(url: string, label: string): Promise<Uint8Array | null> {
  const reply = await fetch(url);
  if (reply.status === 404) return null;
  if (!reply.ok) throw new BoxStoreSyncError(`agent-store read failed for ${label}: ${reply.status}`);
  return new Uint8Array(await reply.arrayBuffer());
}

export const PRESIGN_READ_BATCH_MAX = 500;

/** Read urls for many files at once, asked for in batches the store will take. */
export async function presignAgentStoreReadBatch(client: AgentStoreClient, sourceId: string, relPaths: readonly string[]): Promise<Map<string, { readonly url: string; readonly expiresAtMs: number }>> {
  const urls = new Map<string, { readonly url: string; readonly expiresAtMs: number }>();
  for (let index = 0; index < relPaths.length; index += PRESIGN_READ_BATCH_MAX) {
    const batch = relPaths.slice(index, index + PRESIGN_READ_BATCH_MAX);
    const reads = await client.presignReads({ agentId: sourceId, relPaths: [...batch] });
    for (const read of reads) urls.set(read.relPath, { url: read.url, expiresAtMs: read.expiresAtMs });
  }
  return urls;
}

/** A file's contents streamed to the store: the box never holds the whole object to send it. */
async function streamPut(url: string, headers: Record<string, string>, srcPath: string): Promise<number> {
  const targetUrl = new URL(url);
  const transport = targetUrl.protocol === "http:" ? http : https;
  const body = createReadStream(srcPath);
  try {
    return await new Promise<number>((resolve, reject) => {
      let done = false;
      const finish = (error?: unknown, code?: number) => {
        if (done) return;
        done = true;
        if (error === undefined) resolve(code ?? 0);
        else reject(error);
      };
      const request = transport.request(targetUrl, { method: "PUT", headers }, (reply) => {
        reply.on("error", (error) => finish(error));
        reply.resume();
        reply.on("end", () => finish(undefined, reply.statusCode ?? 0));
      });
      request.on("error", (error) => finish(error));
      void pipeline(body, request).catch((error) => finish(error));
    });
  } catch (error) {
    body.destroy();
    throw error;
  }
}

export async function putAgentStoreObjectFromFile(args: { readonly client: AgentStoreClient; readonly sourceId: string; readonly relPath: string; readonly srcPath: string; readonly sha: string; readonly size: number }): Promise<void> {
  const { client, sourceId, relPath, srcPath, sha, size } = args;
  const instruction = await presignWrite(client, sourceId, { relPath, sha, size }, { expectAbsent: true });
  warnDowngraded(instruction);
  const headers = { ...putHeaders(instruction), "content-length": String(size) };
  let code = await streamPut(instruction.url, headers, srcPath);
  if (code === 409) code = await streamPut(instruction.url, headers, srcPath);
  if (code === 412) return;
  if (code < 200 || code >= 300) throw new BoxStoreSyncError(`agent-store write failed for ${relPath}: ${code}`);
}

export async function getAgentStoreObjectToFile(client: AgentStoreClient, sourceId: string, relPath: string, destPath: string, maxBytes?: number): Promise<number | null> {
  const [instruction] = await client.presignReads({ agentId: sourceId, relPaths: [relPath] });
  return instruction === undefined ? null : fetchAgentStoreObjectToFileFromUrl(instruction.url, relPath, destPath, maxBytes);
}

/** An object streamed into a file, stopped as soon as it grows past what the caller will hold. */
export async function fetchAgentStoreObjectToFileFromUrl(url: string, label: string, destPath: string, maxBytes?: number): Promise<number | null> {
  const reply = await fetch(url, { redirect: "error" });
  if (reply.status === 404) return null;
  if (!reply.ok) throw new BoxStoreSyncError(`agent-store read failed for ${label}: ${reply.status}`);
  if (reply.body === null) throw new BoxStoreSyncError(`agent-store read for ${label} returned no body`);
  await mkdir(dirname(destPath), { recursive: true });
  let written = 0;
  const sizeTap = new Transform({
    transform(batch, _encoding, callback) {
      const buffer = Buffer.isBuffer(batch) ? batch : Buffer.from(batch);
      written += buffer.byteLength;
      if (maxBytes !== undefined && written > maxBytes) {
        callback(new Error(`agent-store object ${label} exceeded ${maxBytes}B`));
        return;
      }
      callback(null, buffer);
    },
  });
  await pipeline(Readable.fromWeb(reply.body as import("node:stream/web").ReadableStream), sizeTap, createWriteStream(destPath));
  return written;
}

export async function listAgentStoreObjects(client: AgentStoreClient, sourceId: string, prefix: string): Promise<string[]> {
  const reply = await client.listFiles({ agentId: sourceId, relPath: prefix });
  return reply.files.map((file) => file.relPath);
}
