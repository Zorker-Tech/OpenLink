/**
 * The box's store as the platform's own service holds it.
 *
 * This is the second backend a box's store can live in: the service presigns every read and write, the box streams the
 * bytes itself, and what this file owns is the parts that keep that honest:
 *
 * - **what a write is based on**: what this session already knows about the key, or what the service's own stat says
 *   (an object that exists without an etag is not a baseline), and a lost race is reported as a conflict rather than
 *   retried forever;
 * - **how a large file goes up**: past the multipart threshold the file is planned into parts first — every part hashed,
 *   and the whole file hashed as it is read, checked against what the caller said it was — each part streamed from its
 *   own range and tried once more if the object store refuses, and the upload finished with a bounded number of
 *   attempts, abandoned if it cannot be finished;
 * - **how presigns are asked for**: writes are coalesced into one request per batch (so a burst of small writes costs
 *   one round trip), reads are asked for in batches the service will take, and an answer that names another file than
 *   the one asked about is refused;
 * - **what it never does**: delete. Both stores here are append-only, and saying so loudly beats a half-deleted store.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { isInvalidArgumentConnectError } from "../../../shared/connect-errors.ts";
import { invariant } from "../../../shared/invariant.ts";
import { sha256Hex } from "../../sha256.ts";
import type { BoxObjectStore, BoxObjectStoreProvider } from "./box-object-store.ts";
import { BoxStoreCanonicalWriteConflictError } from "./object-store-port.ts";
import { BoxStoreSyncError } from "./box-store-sync-error.ts";
import { fetchAgentStoreObjectFromUrl, fetchAgentStoreObjectToFileFromUrl } from "./agent-store-slate-files.ts";
import { createRequestCoalescer } from "./request-coalescer.ts";

export const SLATE_BOX_STORE_MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;
export const SLATE_BOX_STORE_MULTIPART_PART_SIZE_BYTES = 128 * 1024 * 1024;
export const S3_MAX_SINGLE_PUT_BYTES = 5 * 1024 * 1024 * 1024;
export const MULTIPART_COMPLETE_MAX_ATTEMPTS = 3;
export const READ_PRESIGN_BATCH_MAX = 500;
export const WRITE_PRESIGN_BATCH_MAX = 64;
const PREFETCHED_READ_FRESHNESS_MARGIN_MS = 30_000;
const MULTIPART_FAILURE_PRECONDITION_FAILED = 1;
const MULTIPART_FAILURE_TRANSIENT = 5;
/** The service's own names for what can go wrong with a multipart write, by its code. */
const MULTIPART_FAILURE_NAMES = ["UNSPECIFIED", "PRECONDITION_FAILED", "UPLOAD_NOT_FOUND", "INVALID_PARTS", "CHECKSUM_MISMATCH", "TRANSIENT", "INTERNAL", "RESTART_REQUIRED"] as const;

export interface MultipartPart {
  readonly partNumber: number;
  readonly offsetBytes: number;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface SlateBoxStoreWriteFile {
  readonly relPath: string;
  readonly sha256: string;
  readonly sizeBytes: bigint;
  readonly contentAddressed: boolean;
  readonly ifMatchEtag: string;
  readonly expectAbsent: boolean;
  readonly multipartParts?: readonly { readonly partNumber: number; readonly sizeBytes: bigint; readonly sha256: string }[];
}

export interface SlateBoxStoreMultipartInstruction {
  readonly context: unknown | null;
  readonly parts: readonly { readonly partNumber: number; readonly offsetBytes: bigint; readonly sizeBytes: bigint; readonly url: string; readonly headers: Readonly<Record<string, string>> }[];
}

export interface SlateBoxStoreWriteInstruction {
  readonly relPath: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly multipart?: SlateBoxStoreMultipartInstruction;
}

/** The store's service as this box reads it: what it presigns, what it stats, and how a multipart write is finished. */
export interface SlateBoxStoreServiceClient {
  presignSandBoxStoreReads(args: { readonly relPaths: readonly string[] }): Promise<{ readonly instructions: readonly { readonly relPath: string; readonly url: string; readonly expiresAtMs: bigint | number }[] }>;
  statSandBoxStoreObject(args: { readonly relPath: string }): Promise<{ readonly exists: boolean; readonly etag: string }>;
  presignSandBoxStoreWrites(args: { readonly files: readonly SlateBoxStoreWriteFile[] }): Promise<{ readonly instructions: readonly SlateBoxStoreWriteInstruction[] }>;
  completeSandBoxStoreMultipartWrites(args: { readonly completions: readonly { readonly context: unknown; readonly parts: readonly { readonly partNumber: number; readonly etag: string }[] }[] }): Promise<{
    readonly results: readonly {
      readonly outcome: { readonly case: "success"; readonly value?: unknown } | { readonly case: "failure"; readonly value: { readonly code: number } } | { readonly case: undefined; readonly value?: undefined };
    }[];
  }>;
  abortSandBoxStoreMultipartWrites(args: { readonly uploads: readonly { readonly context: unknown }[] }): Promise<unknown>;
  listSandBoxStoreObjects(args: { readonly prefix: string; readonly cursor: string; readonly maxEntries: number }): Promise<{ readonly entries: readonly { readonly relPath: string }[]; readonly truncated: boolean; readonly nextCursor: string }>;
}

export interface SlateBoxStoreServiceDependencies {
  readonly client?: SlateBoxStoreServiceClient;
  readonly getAccessToken?: (...args: unknown[]) => unknown;
  readonly getMachineId?: (...args: unknown[]) => unknown;
  readonly multipartThresholdBytes?: number;
  readonly multipartPartSizeBytes?: number;
}

/** The service's own transport is not this host's to build: without a client there is nothing to talk to. */
export function createSlateBoxStoreServiceClient(deps: SlateBoxStoreServiceDependencies): SlateBoxStoreServiceClient {
  if (deps.client !== undefined) return deps.client;
  throw new BoxStoreSyncError("slate-box-store service client construction requires a transport this host does not build yet");
}

/**
 * A file cut into the parts a multipart write needs: each part's own hash, and the hash of the whole file as it is read,
 * which the caller's own sha is checked against.
 */
export async function planSlateBoxStoreMultipartParts(srcPath: string, sizeBytes: number, partSizeBytes = SLATE_BOX_STORE_MULTIPART_PART_SIZE_BYTES): Promise<{ readonly parts: MultipartPart[]; readonly wholeSha256: string }> {
  if (sizeBytes <= 0 || !Number.isSafeInteger(sizeBytes)) throw new BoxStoreSyncError(`multipart plan requires a positive size, got ${sizeBytes}`);
  if (partSizeBytes <= 0 || !Number.isSafeInteger(partSizeBytes)) throw new BoxStoreSyncError(`multipart plan requires a positive part size, got ${partSizeBytes}`);
  const parts: MultipartPart[] = [];
  const wholeHash = createHash("sha256");
  let partHash = createHash("sha256");
  let partStart = 0;
  let position = 0;
  const finishPart = (): void => {
    parts.push({ partNumber: parts.length + 1, offsetBytes: partStart, sizeBytes: position - partStart, sha256: partHash.digest("hex") });
    partHash = createHash("sha256");
    partStart = position;
  };
  for await (const chunk of createReadStream(srcPath)) {
    let buffer = chunk as Buffer;
    while (buffer.byteLength > 0) {
      // A chunk may hold more than one part's worth, so it is cut at the part boundary rather than trusted.
      const take = Math.min(partStart + partSizeBytes - position, buffer.byteLength);
      const slice = buffer.subarray(0, take);
      partHash.update(slice);
      wholeHash.update(slice);
      position += take;
      buffer = buffer.subarray(take);
      if (position - partStart === partSizeBytes) finishPart();
    }
  }
  if (position !== sizeBytes) throw new BoxStoreSyncError(`multipart plan read ${position}B but expected ${sizeBytes}B: the file changed under the plan`);
  if (position > partStart) finishPart();
  return { parts, wholeSha256: wholeHash.digest("hex") };
}

/** A file streamed to the store whole, with the status the object store answered with. */
async function streamPutFromFile(url: string, headers: Record<string, string>, srcPath: string): Promise<number> {
  const parsedUrl = new URL(url);
  const transport = parsedUrl.protocol === "http:" ? http : https;
  const body = createReadStream(srcPath);
  try {
    return await new Promise<number>((resolve, reject) => {
      let settled = false;
      const settle = (error?: unknown, status?: number) => {
        if (settled) return;
        settled = true;
        if (error === undefined) resolve(status ?? 0);
        else reject(error);
      };
      const request = transport.request(parsedUrl, { method: "PUT", headers }, (response) => {
        response.on("error", (error) => settle(error));
        response.resume();
        response.on("end", () => settle(undefined, response.statusCode ?? 0));
      });
      request.on("error", (error) => settle(error));
      void pipeline(body, request).catch((error) => settle(error));
    });
  } catch (error) {
    body.destroy();
    throw error;
  }
}

/** One part of a file streamed from its own range, with the etag the object store answered with. */
async function streamPutRangeFromFile(url: string, headers: Record<string, string>, srcPath: string, offsetBytes: number, sizeBytes: number): Promise<{ readonly status: number; readonly etag: string }> {
  const parsedUrl = new URL(url);
  const transport = parsedUrl.protocol === "http:" ? http : https;
  const body = createReadStream(srcPath, { start: offsetBytes, end: offsetBytes + sizeBytes - 1 });
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error?: unknown, result?: { readonly status: number; readonly etag: string }) => {
        if (settled) return;
        settled = true;
        if (error === undefined) resolve(result ?? { status: 0, etag: "" });
        else reject(error);
      };
      const request = transport.request(parsedUrl, { method: "PUT", headers }, (response) => {
        response.on("error", (error) => settle(error));
        const rawEtag = response.headers.etag;
        const etag = typeof rawEtag === "string" ? rawEtag.replaceAll('"', "").trim() : "";
        response.resume();
        response.on("end", () => settle(undefined, { status: response.statusCode ?? 0, etag }));
      });
      request.on("error", (error) => settle(error));
      void pipeline(body, request).catch((error) => settle(error));
    });
  } catch (error) {
    body.destroy();
    throw error;
  }
}

export class SlateBoxStoreServiceProvider implements BoxObjectStoreProvider {
  private readonly client: SlateBoxStoreServiceClient;
  private readonly multipartThresholdBytes: number;
  private readonly multipartPartSizeBytes: number;
  private storeInstance: SlateBoxStoreServiceObjectStore | undefined;

  constructor(deps: SlateBoxStoreServiceDependencies) {
    this.client = deps.client ?? createSlateBoxStoreServiceClient(deps);
    this.multipartThresholdBytes = deps.multipartThresholdBytes ?? SLATE_BOX_STORE_MULTIPART_THRESHOLD_BYTES;
    this.multipartPartSizeBytes = deps.multipartPartSizeBytes ?? SLATE_BOX_STORE_MULTIPART_PART_SIZE_BYTES;
  }

  /** One store serves every id: the service itself is scoped by the account, not by the store it is asked about. */
  forStore(_storeId: string): SlateBoxStoreServiceObjectStore {
    this.storeInstance ??= new SlateBoxStoreServiceObjectStore(this.client, this.multipartThresholdBytes, this.multipartPartSizeBytes);
    return this.storeInstance;
  }
}

export class SlateBoxStoreServiceObjectStore implements BoxObjectStore {
  private readonly sessionEtags = new Map<string, string>();
  private readonly prefetchedReads = new Map<string, { readonly url: string; readonly expiresAtMs: number }>();
  private readonly writePresignCoalescer: (file: SlateBoxStoreWriteFile) => Promise<SlateBoxStoreWriteInstruction>;

  constructor(
    readonly client: SlateBoxStoreServiceClient,
    readonly multipartThresholdBytes = SLATE_BOX_STORE_MULTIPART_THRESHOLD_BYTES,
    readonly multipartPartSizeBytes = SLATE_BOX_STORE_MULTIPART_PART_SIZE_BYTES,
  ) {
    this.writePresignCoalescer = createRequestCoalescer({
      maxBatchSize: WRITE_PRESIGN_BATCH_MAX,
      run: (files) => this.presignWriteBatch(files),
      conflictKey: (file) => file.relPath,
      shouldSplitOnError: isInvalidArgumentConnectError,
    });
  }

  async prefetchReads(keys: readonly string[]): Promise<void> {
    for (let index = 0; index < keys.length; index += READ_PRESIGN_BATCH_MAX) {
      const chunk = keys.slice(index, index + READ_PRESIGN_BATCH_MAX);
      const response = await this.client.presignSandBoxStoreReads({ relPaths: [...chunk] });
      for (const instruction of response.instructions) this.prefetchedReads.set(instruction.relPath, { url: instruction.url, expiresAtMs: Number(instruction.expiresAtMs) });
    }
  }

  /** A prefetched url is used once, and only while it has time left on it. */
  private takePrefetchedRead(key: string): { readonly url: string; readonly expiresAtMs: number } | undefined {
    const cached = this.prefetchedReads.get(key);
    if (cached === undefined) return undefined;
    this.prefetchedReads.delete(key);
    return cached.expiresAtMs - Date.now() > PREFETCHED_READ_FRESHNESS_MARGIN_MS ? cached : undefined;
  }

  private async presignRead(key: string): Promise<string | null> {
    const response = await this.client.presignSandBoxStoreReads({ relPaths: [key] });
    return response.instructions[0]?.url ?? null;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const cached = this.takePrefetchedRead(key);
    if (cached !== undefined) {
      try {
        const viaCache = await fetchAgentStoreObjectFromUrl(cached.url, key);
        if (viaCache !== null) return viaCache;
      } catch {
        // A url that did not work is not the caller's problem: the read is presigned again below.
      }
    }
    const url = await this.presignRead(key);
    return url === null ? null : fetchAgentStoreObjectFromUrl(url, key);
  }

  async getToFile(key: string, destPath: string, options?: { readonly maxBytes?: number }): Promise<number | null> {
    const cached = this.takePrefetchedRead(key);
    if (cached !== undefined) {
      try {
        const viaCache = await fetchAgentStoreObjectToFileFromUrl(cached.url, key, destPath, options?.maxBytes);
        if (viaCache !== null) return viaCache;
      } catch {
        // As above: a prefetched url that failed falls back to a fresh one.
      }
    }
    const url = await this.presignRead(key);
    return url === null ? null : fetchAgentStoreObjectToFileFromUrl(url, key, destPath, options?.maxBytes);
  }

  async put(key: string, bytes: Uint8Array, options?: { readonly contentAddressed?: boolean }): Promise<void> {
    if (options?.contentAddressed === true) {
      await this.putContentAddressed(key, bytes);
      return;
    }
    await this.putMutable(key, bytes);
  }

  /** A write that only happens when nothing is there: a refusal that says so is the write's own success. */
  private async putContentAddressed(key: string, bytes: Uint8Array): Promise<void> {
    const instruction = await this.presignWrite({ relPath: key, sha256: sha256Hex(bytes), sizeBytes: BigInt(bytes.byteLength), contentAddressed: true, ifMatchEtag: "", expectAbsent: false });
    const putOnce = () => fetch(instruction.url, { method: "PUT", headers: { ...instruction.headers }, body: Buffer.from(bytes) });
    let response = await putOnce();
    if (response.status === 409) response = await putOnce();
    if (response.status === 412) return;
    if (!response.ok) throw new BoxStoreSyncError(`slate-box-store write failed for ${key}: ${response.status}`);
  }

  /** A write that is based on what is there: what this session knows, or what the service's stat says. */
  private async putMutable(key: string, bytes: Uint8Array): Promise<void> {
    const known = this.sessionEtags.get(key);
    let baseEtag: string | null;
    let baselineSource: "session" | "probe" | "absent";
    if (known !== undefined) {
      baseEtag = known;
      baselineSource = "session";
    } else {
      const stat = await this.client.statSandBoxStoreObject({ relPath: key });
      if (stat.exists) {
        // An object that exists without an etag is not a baseline this write can be made against.
        if (stat.etag.length === 0) throw new BoxStoreSyncError(`slate-box-store write for ${key} has no usable baseline: the object exists but stat carried no etag`);
        baseEtag = stat.etag;
        baselineSource = "probe";
      } else {
        baseEtag = null;
        baselineSource = "absent";
      }
    }
    const instruction = await this.presignWrite({ relPath: key, sha256: sha256Hex(bytes), sizeBytes: BigInt(bytes.byteLength), contentAddressed: false, ifMatchEtag: baseEtag ?? "", expectAbsent: baseEtag === null });
    const putOnce = () => fetch(instruction.url, { method: "PUT", headers: { ...instruction.headers }, body: Buffer.from(bytes) });
    let response = await putOnce();
    if (response.status === 409) response = await putOnce();
    if (response.status === 412 || response.status === 409) {
      // The race was lost: what this session knew is no longer what is there.
      this.sessionEtags.delete(key);
      throw new BoxStoreCanonicalWriteConflictError({ key, conflictRelPath: null, baseEtag, baselineSource });
    }
    if (!response.ok) throw new BoxStoreSyncError(`slate-box-store write failed for ${key}: ${response.status}`);
    const etag = response.headers.get("etag");
    const normalized = etag === null ? "" : etag.replaceAll('"', "").trim();
    if (normalized.length > 0) this.sessionEtags.set(key, normalized);
    else this.sessionEtags.delete(key);
  }

  async putFromFile(key: string, srcPath: string, sha: string, size: number): Promise<void> {
    // Past the threshold the file is planned into parts first, so the service can be asked for a multipart write.
    const multipartParts = size >= this.multipartThresholdBytes ? await this.planMultipartParts(key, srcPath, sha, size) : undefined;
    const instruction = await this.writePresignCoalescer({ relPath: key, sha256: sha, sizeBytes: BigInt(size), contentAddressed: true, ifMatchEtag: "", expectAbsent: false, ...(multipartParts === undefined ? {} : { multipartParts }) });
    if (instruction.multipart != null) {
      await this.uploadMultipart(key, srcPath, instruction.multipart);
      return;
    }
    // A single PUT cannot carry more than the object store allows, and there is no multipart instruction to fall back on.
    if (size > S3_MAX_SINGLE_PUT_BYTES) throw new BoxStoreSyncError(`slate-box-store write for ${key} is ${size}B, over the S3 single-PUT maximum, and the backend returned no multipart instruction`);
    const headers = { ...instruction.headers, "content-length": String(size) };
    let status = await streamPutFromFile(instruction.url, headers, srcPath);
    if (status === 409) status = await streamPutFromFile(instruction.url, headers, srcPath);
    if (status === 412) return;
    if (status < 200 || status >= 300) throw new BoxStoreSyncError(`slate-box-store write failed for ${key}: ${status}`);
  }

  private async planMultipartParts(key: string, srcPath: string, sha: string, size: number): Promise<readonly { readonly partNumber: number; readonly sizeBytes: bigint; readonly sha256: string }[]> {
    const plan = await planSlateBoxStoreMultipartParts(srcPath, size, this.multipartPartSizeBytes);
    // The plan read the whole file, so it can say whether the file is still the one the caller named.
    if (plan.wholeSha256 !== sha) throw new BoxStoreSyncError(`slate-box-store multipart plan for ${key} hashed ${plan.wholeSha256} but the caller expected ${sha}`);
    return plan.parts.map((part) => ({ partNumber: part.partNumber, sizeBytes: BigInt(part.sizeBytes), sha256: part.sha256 }));
  }

  /** Every part streamed from its own range, then the upload finished with a bounded number of attempts. */
  private async uploadMultipart(key: string, srcPath: string, multipart: SlateBoxStoreMultipartInstruction): Promise<void> {
    const context = multipart.context;
    if (context == null) throw new BoxStoreSyncError(`slate-box-store multipart instruction for ${key} carries no upload context`);
    try {
      const uploaded: { readonly partNumber: number; readonly etag: string }[] = [];
      const parts = [...multipart.parts].sort((left, right) => left.partNumber - right.partNumber);
      for (const part of parts) {
        const headers = { ...part.headers, "content-length": String(part.sizeBytes) };
        const putPart = () => streamPutRangeFromFile(part.url, headers, srcPath, Number(part.offsetBytes), Number(part.sizeBytes));
        let result = await putPart();
        if (result.status < 200 || result.status >= 300) result = await putPart();
        if (result.status < 200 || result.status >= 300) throw new BoxStoreSyncError(`slate-box-store multipart part ${part.partNumber} failed for ${key}: ${result.status}`);
        // A part without an etag cannot be named in the completion, so the upload cannot be finished.
        if (result.etag.length === 0) throw new BoxStoreSyncError(`slate-box-store multipart part ${part.partNumber} for ${key} returned no etag`);
        uploaded.push({ partNumber: part.partNumber, etag: result.etag });
      }
      let lastFailure: string | undefined = "no result";
      for (let attempt = 1; attempt <= MULTIPART_COMPLETE_MAX_ATTEMPTS; attempt += 1) {
        let result: Awaited<ReturnType<SlateBoxStoreServiceClient["completeSandBoxStoreMultipartWrites"]>>["results"][number] | undefined;
        try {
          const response = await this.client.completeSandBoxStoreMultipartWrites({ completions: [{ context, parts: uploaded }] });
          result = response.results[0];
        } catch (error) {
          lastFailure = error instanceof Error ? error.message : String(error);
          continue;
        }
        if (result?.outcome.case === "success") return;
        const code = result?.outcome.case === "failure" ? result.outcome.value.code : undefined;
        // A refusal about the precondition means the object is already what was uploaded.
        if (code === MULTIPART_FAILURE_PRECONDITION_FAILED) return;
        lastFailure = code === undefined ? "no result" : MULTIPART_FAILURE_NAMES[code];
        // Only a failure the service calls transient is worth trying again.
        if (code !== MULTIPART_FAILURE_TRANSIENT) break;
      }
      throw new BoxStoreSyncError(`slate-box-store multipart complete failed for ${key}: ${lastFailure}`);
    } catch (error) {
      await this.bestEffortAbortMultipart(context);
      throw error;
    }
  }

  private async bestEffortAbortMultipart(context: unknown): Promise<void> {
    try {
      await this.client.abortSandBoxStoreMultipartWrites({ uploads: [{ context }] });
    } catch {
      // Abandoning an upload that could not be finished is best effort: the failure to report is the first one.
    }
  }

  /** One request for a whole batch of presigns, with every answer checked to be about the file that asked for it. */
  private async presignWriteBatch(files: SlateBoxStoreWriteFile[]): Promise<SlateBoxStoreWriteInstruction[]> {
    const response = await this.client.presignSandBoxStoreWrites({
      files: files.map(({ multipartParts, ...file }) => ({ ...file, ...(multipartParts === undefined ? {} : { multipartParts: multipartParts.map((part) => ({ ...part })) }) })),
    });
    return files.map((file, index) => {
      const instruction = response.instructions[index];
      if (instruction?.relPath !== file.relPath) throw new BoxStoreSyncError(`slate-box-store presign returned ${instruction?.relPath ?? "nothing"} for ${file.relPath}`);
      return instruction;
    });
  }

  private async presignWrite(file: SlateBoxStoreWriteFile): Promise<{ readonly url: string; readonly headers: Record<string, string> }> {
    const instruction = await this.writePresignCoalescer(file);
    return { url: instruction.url, headers: { ...instruction.headers } };
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = "";
    for (;;) {
      const page = await this.client.listSandBoxStoreObjects({ prefix, cursor, maxEntries: 0 });
      for (const entry of page.entries) keys.push(entry.relPath);
      // A page that says it was cut short is followed; one that cannot name a cursor is the end of the listing.
      if (!page.truncated || page.nextCursor.length === 0) return keys;
      cursor = page.nextCursor;
    }
  }

  async delete(key: string): Promise<void> {
    invariant(false, () => `SlateBoxStoreServiceObjectStore is append-only; cannot delete ${key}`);
  }
}
