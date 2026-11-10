/**
 * The agent store, over the box's own service.
 *
 * Every call the sync engine makes to the store goes through here: a token for the store it wants, a directory listing
 * (walked page by page, or taken whole when the store offers it that way), the presigned urls a read or a write needs,
 * the two halves of a multipart write, and a delete. Two things are this file's own rules rather than the store's:
 *
 * - what it keeps for a moment: a listing is remembered for as long as it is fresh, a whole-store listing is remembered
 *   for every directory inside it, and anything that changes the store (a write, a completion, a delete) forgets what
 *   was kept — including a listing that answered only with entries it should never have handed over;
 * - what it refuses to believe: an answer that names a file nobody asked about, that answers the same input twice,
 *   that is out of range, that contradicts itself about a precondition, or that carries no precondition at all is an
 *   error rather than a silent success.
 *
 * What the store answers with is read defensively throughout (the wire's own numbers become numbers, tags are
 * normalized, paths are normalized), so a shape this file does not expect fails loudly here rather than later.
 */
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { adaptBcsAgentStoreRpcClient, createBcsAgentStoreClient, type BcsAgentStoreRpcClient } from "../../adapters/interop/agent-store/bcs-agent-store-client-adapter.ts";
import type {
  AgentStoreCloudClient,
  AgentStoreDeleteOutcome,
  AgentStoreDirectoryPage,
  AgentStoreDirectoryQuery,
  AgentStoreListFile,
  AgentStoreListing,
  AgentStoreMintTarget,
  AgentStoreMultipartRpcResult,
  AgentStoreMultipartContext,
  AgentStoreMultipartWriteAbort,
  AgentStoreMultipartWriteCompletion,
  AgentStoreMultipartWriteInstruction,
  AgentStoreRemoteMultipartWriteInstruction,
  AgentStoreRemoteWriteInstruction,
  AgentStoreRpcCallOptions,
  AgentStoreReadInstruction,
  AgentStoreSourceKind,
  AgentStoreTombstone,
  AgentStoreToken,
  AgentStoreWriteFile,
  AgentStoreWriteInstruction,
} from "./agent-store-sync-contracts.ts";
import { normalizeS3Etag } from "./etag.ts";
import { AgentStoreDirectoryListingError, AgentStoreProtocolError, AgentStoreUnauthorizedError } from "./bcs-client.ts";
import { adaptFlatAgentStoreList } from "./bcs-list-adapter.ts";
import { normalizeRelPath } from "./safe-paths.ts";

export type {
  AgentStoreListFile,
  AgentStoreListing,
  AgentStoreMintTarget,
  AgentStoreMultipartContext,
  AgentStoreMultipartWriteAbort,
  AgentStoreMultipartWriteCompletion,
  AgentStoreMultipartWriteInstruction,
  AgentStoreReadInstruction,
  AgentStoreSourceKind,
  AgentStoreTombstone,
  AgentStoreToken,
  AgentStoreWriteFile,
  AgentStoreWriteInstruction,
} from "./agent-store-sync-contracts.ts";

const AGENT_STORE_TOKEN_HEADER = "x-agent-store-token";

const DIRECTORY_LIST_CACHE_TTL_MS = 1_000;
const DIRECTORY_LIST_PAGE_SIZE = 1_000;
const DIRECTORY_LIST_MAX_PAGES = 10;
const DIRECTORY_LIST_MAX_ENTRIES = DIRECTORY_LIST_PAGE_SIZE * DIRECTORY_LIST_MAX_PAGES;
const DEFAULT_RPC_TIMEOUT_MS = 60_000;

/** The store's service as this transport reads it; what it answers with is read defensively, so it is typed loosely. */
export type BcsAgentStoreClient = AgentStoreCloudClient;

export interface BcsAgentStoreTransportInput {
  readonly client?: BcsAgentStoreClient | BcsAgentStoreRpcClient;
  readonly transport?: Transport;
  readonly now?: () => number;
  readonly flatFileListCacheTtlMs?: number;
  readonly mintTokenHeaders?: Record<string, string>;
  readonly rpcTimeoutMs?: number;
}

function isAgentStoreCloudClient(client: AgentStoreCloudClient | BcsAgentStoreRpcClient): client is AgentStoreCloudClient {
  return typeof (client as AgentStoreCloudClient).mintToken === "function";
}

interface CachedDirectoryListing {
  readonly promise: Promise<AgentStoreListing>;
  readonly expiresAtMs: number;
}
interface CachedFlatListing {
  readonly files: readonly AgentStoreListFile[];
  readonly tombstones: readonly AgentStoreTombstone[];
  readonly expiresAtMs: number;
}

export class BcsAgentStoreTransport {
  private readonly client: BcsAgentStoreClient;
  private readonly now: () => number;
  private readonly directoryListCacheTtlMs: number;
  private readonly mintTokenHeaders: Record<string, string> | undefined;
  private readonly rpcTimeoutMs: number;
  private readonly directoryListCache = new Map<string, CachedDirectoryListing>();
  private readonly completeFlatListCache = new Map<string, CachedFlatListing>();
  /** How many times each store's listing has been dropped; a page that lands after a drop is not kept. */
  private readonly listCacheGenerationByTarget = new Map<string, number>();
  /** Stores that answered a paged listing where a whole-store one was asked for. */
  private readonly knownLargeTargets = new Set<string>();

  constructor(input: BcsAgentStoreTransportInput) {
    this.now = input.now ?? Date.now;
    this.directoryListCacheTtlMs = input.flatFileListCacheTtlMs ?? DIRECTORY_LIST_CACHE_TTL_MS;
    this.mintTokenHeaders = input.mintTokenHeaders;
    this.rpcTimeoutMs = normalizeRpcTimeoutMs(input.rpcTimeoutMs);
    if (input.client !== undefined) {
      this.client = isAgentStoreCloudClient(input.client) ? input.client : adaptBcsAgentStoreRpcClient(input.client);
    } else if (input.transport !== undefined) {
      this.client = createBcsAgentStoreClient(input.transport);
    } else {
      throw new Error("BcsAgentStoreTransport requires either `client` or `transport`.");
    }
  }

  async mintToken(target: AgentStoreMintTarget, options?: { readonly signal?: AbortSignal }): Promise<AgentStoreToken> {
    try {
      return await this.invokeRpc(
        (callOptions) => this.client.mintToken(target, callOptions),
        { ...(this.mintTokenHeaders === undefined ? {} : { headers: { ...this.mintTokenHeaders } }), ...(options?.signal === undefined ? {} : { signal: options.signal }) },
      );
    } catch (error) {
      throw mapConnectError(error);
    }
  }

  async listFiles(args: { readonly token: AgentStoreToken; readonly storeId: string; readonly relPath: string; readonly shareId?: string; readonly signal?: AbortSignal }): Promise<AgentStoreListing> {
    return this.fetchCachedDirectoryList(args);
  }

  async presignReads(args: { readonly token: AgentStoreToken; readonly storeId: string; readonly relPaths: readonly string[]; readonly shareId?: string; readonly signal?: AbortSignal }): Promise<readonly AgentStoreReadInstruction[]> {
    try {
      return await this.invokeRpc(
        (options) => this.client.presignReads({ storeId: args.storeId, ...(args.shareId === undefined ? {} : { shareId: args.shareId }), relPaths: [...args.relPaths] }, options),
        agentStoreCallOptions(args.token.token, args.signal),
      );
    } catch (error) {
      throw mapConnectError(error);
    }
  }

  async presignWrites(args: { readonly token: AgentStoreToken; readonly storeId: string; readonly files: readonly AgentStoreWriteFile[]; readonly signal?: AbortSignal }): Promise<readonly AgentStoreWriteInstruction[]> {
    // A write changes the store, so what was kept of its listing is no longer what is there.
    this.invalidateListCache({ storeId: args.storeId });
    const shaByRelPath = new Map(args.files.map((file) => [normalizeRelPath(file.relPath), file.sha]));
    for (const file of args.files) {
      if (file.baseEtag !== undefined && file.expectAbsent === true) throw new Error(`Agent store write for ${file.relPath} sets both baseEtag and expectAbsent; they are mutually exclusive`);
      if (file.baseEtag !== undefined && normalizeS3Etag(file.baseEtag).length === 0) throw new Error(`Agent store write for ${file.relPath} carries an empty baseEtag`);
    }
    try {
      const instructions = await this.invokeRpc(
        (options) => this.client.presignWrites({ storeId: args.storeId, files: args.files }, options),
        agentStoreCallOptions(args.token.token, args.signal),
      );
      return instructions.map((instruction, index) => this.readWriteInstruction({ instruction, requested: args.files[index], shaByRelPath }));
    } catch (error) {
      throw mapConnectError(error);
    }
  }

  async completeMultipartWrites(args: { readonly token: AgentStoreToken; readonly storeId: string; readonly completions: readonly AgentStoreMultipartWriteCompletion[]; readonly signal?: AbortSignal }): Promise<readonly { readonly kind: "success" | "failure"; readonly relPath: string; readonly etag?: string; readonly code?: string }[]> {
    this.invalidateListCache({ storeId: args.storeId });
    try {
      const results = await this.invokeRpc(
        (options) => this.client.completeWrites({ storeId: args.storeId, completions: args.completions }, options),
        agentStoreCallOptions(args.token.token, args.signal),
      );
      return correlateMultipartResults({ kind: "complete", inputs: args.completions, results, map: mapMultipartCompletionResult });
    } catch (error) {
      throw mapConnectError(error);
    } finally {
      this.invalidateListCache({ storeId: args.storeId });
    }
  }

  async abortMultipartWrites(args: { readonly token: AgentStoreToken; readonly storeId: string; readonly uploads: readonly AgentStoreMultipartWriteAbort[]; readonly signal?: AbortSignal }): Promise<readonly { readonly kind: "success" | "failure"; readonly relPath: string; readonly alreadyFinished?: boolean; readonly code?: string }[]> {
    try {
      const results = await this.invokeRpc(
        (options) => this.client.abortWrites({ storeId: args.storeId, uploads: args.uploads }, options),
        agentStoreCallOptions(args.token.token, args.signal),
      );
      return correlateMultipartResults({ kind: "abort", inputs: args.uploads, results, map: mapMultipartAbortResult });
    } catch (error) {
      throw mapConnectError(error);
    }
  }

  async deleteFiles(args: { readonly token: AgentStoreToken; readonly storeId: string; readonly files: readonly { readonly relPath: string; readonly baseEtag: string; readonly mutationId?: string }[]; readonly signal?: AbortSignal }): Promise<readonly { readonly relPath: string; readonly status: string; readonly tombstoneEtag?: string; readonly currentEtag?: string }[]> {
    for (const file of args.files) if (normalizeS3Etag(file.baseEtag).length === 0) throw new Error(`Agent store delete for ${file.relPath} carries an empty baseEtag`);
    this.invalidateListCache({ storeId: args.storeId });
    try {
      const response = await this.invokeRpc(
        (options) => this.client.deleteFiles({ storeId: args.storeId, files: args.files.map((file) => ({ ...file, baseEtag: normalizeS3Etag(file.baseEtag) })) }, options),
        agentStoreCallOptions(args.token.token, args.signal),
      );
      const outcomes = response.map(deleteOutcomeOf);
      this.invalidateListCache({ storeId: args.storeId });
      return outcomes;
    } catch (error) {
      throw mapConnectError(error);
    }
  }

  /** Forgetting a store's listing: nothing already in flight is kept, and a page that lands later is not either. */
  invalidateListCache({ storeId, shareId }: { readonly storeId: string; readonly shareId?: string }): void {
    const targets = listingTargets({ storeId, ...(shareId === undefined ? {} : { shareId }) });
    for (const target of targets) this.listCacheGenerationByTarget.set(target, (this.listCacheGenerationByTarget.get(target) ?? 0) + 1);
    for (const key of this.directoryListCache.keys()) if (targets.has(targetOfCacheKey(key))) this.directoryListCache.delete(key);
    for (const key of this.completeFlatListCache.keys()) if (targets.has(targetOfCacheKey(key))) this.completeFlatListCache.delete(key);
  }

  private fetchCachedDirectoryList(args: { readonly token: AgentStoreToken; readonly storeId: string; readonly relPath: string; readonly shareId?: string; readonly signal?: AbortSignal }): Promise<AgentStoreListing> {
    if (args.signal?.aborted === true) return Promise.reject(args.signal.reason instanceof Error ? args.signal.reason : new DOMException("The operation was aborted", "AbortError"));
    const now = this.now();
    this.dropExpiredListings(now);
    // A whole-store listing answers every directory inside it, so a directory inside it is answered from that.
    const flat = this.completeFlatListCache.get(completeFlatListCacheKey(args));
    if (flat !== undefined) return Promise.resolve(adaptFlatAgentStoreList({ files: flat.files, relPath: args.relPath, tombstones: flat.tombstones, listingComplete: true }));
    const cacheKey = directoryListCacheKey(args);
    let entry = this.directoryListCache.get(cacheKey);
    if (entry === undefined || entry.expiresAtMs <= now) {
      const promise = this.fetchDirectoryList(args)
        .then((listing) => {
          // A listing that answered only with entries it should never have handed over is not worth keeping.
          if (isUncacheableAllUnsafeListing(listing) && this.directoryListCache.get(cacheKey)?.promise === promise) this.directoryListCache.delete(cacheKey);
          return listing;
        })
        .catch((error) => {
          if (this.directoryListCache.get(cacheKey)?.promise === promise) this.directoryListCache.delete(cacheKey);
          throw error;
        });
      entry = { promise, expiresAtMs: now + this.directoryListCacheTtlMs };
      this.directoryListCache.set(cacheKey, entry);
    }
    return entry.promise;
  }

  private dropExpiredListings(now: number): void {
    for (const [key, candidate] of this.completeFlatListCache) if (candidate.expiresAtMs <= now) this.completeFlatListCache.delete(key);
    for (const [key, candidate] of this.directoryListCache) if (candidate.expiresAtMs <= now) this.directoryListCache.delete(key);
  }

  /**
   * One directory listing: the store is asked for the whole store first when it might answer that way, and otherwise
   * walked page by page, with each page's files, directories and tombstones folded together and the limits enforced as
   * the pages arrive.
   */
  private async fetchDirectoryList(args: { readonly token: AgentStoreToken; readonly storeId: string; readonly relPath: string; readonly shareId?: string; readonly signal?: AbortSignal }): Promise<AgentStoreListing> {
    try {
      const files = new Map<string, AgentStoreListFile>();
      const subdirs = new Set<string>();
      const tombstones = new Map<string, AgentStoreTombstone>();
      const seenPageTokens = new Set<string>();
      const targetKey = listingTargetKey(args);
      const cacheGeneration = this.listCacheGenerationByTarget.get(targetKey) ?? 0;
      // Only the root of a store that has never answered a paged listing is asked for the whole store at once.
      const preferCompleteFlatStore = args.relPath === "" && !this.knownLargeTargets.has(targetKey);
      let pageToken = "";
      let pageCount = 0;
      do {
        pageCount += 1;
        if (pageCount > DIRECTORY_LIST_MAX_PAGES) throw new AgentStoreDirectoryListingError(`Agent store directory listing exceeded ${DIRECTORY_LIST_MAX_PAGES} pages`);
        const response = await this.invokeRpc(
          (options) => this.client.listDirectory({
            storeId: args.storeId,
            ...(args.shareId === undefined ? {} : { shareId: args.shareId }),
            relativePath: args.relPath,
            pageSize: DIRECTORY_LIST_PAGE_SIZE,
            pageToken,
            preferCompleteFlatStore: preferCompleteFlatStore && pageToken === "",
          }, options),
          agentStoreCallOptions(args.token.token, args.signal),
        );
        if (response.kind === "complete") {
          const flatFiles = response.files.map((file) => ({ ...file, etag: normalizeS3Etag(file.etag) }));
          const flatTombstones = normalizeTombstones(response.tombstones);
          if (flatFiles.length + flatTombstones.length > DIRECTORY_LIST_MAX_ENTRIES) throw new AgentStoreDirectoryListingError(`Agent store directory listing exceeded ${DIRECTORY_LIST_MAX_ENTRIES} entries`);
          const completeListing = adaptFlatAgentStoreList({ files: flatFiles, relPath: "", tombstones: flatTombstones, listingComplete: true });
          // What the whole store held is kept for every directory inside it, unless it was dropped meanwhile.
          if ((this.listCacheGenerationByTarget.get(targetKey) ?? 0) === cacheGeneration && !isUncacheableAllUnsafeListing(completeListing)) this.completeFlatListCache.set(completeFlatListCacheKey(args), { files: completeListing.files, tombstones: flatTombstones, expiresAtMs: this.now() + this.directoryListCacheTtlMs });
          return completeListing;
        }
        // A store that answered page by page where a whole-store listing was asked for is a large one.
        if (preferCompleteFlatStore && pageToken === "") this.knownLargeTargets.add(targetKey);
        for (const file of response.files) files.set(file.relPath, { ...file, etag: normalizeS3Etag(file.etag) });
        for (const subdir of response.subdirs) subdirs.add(subdir);
        for (const tombstone of normalizeTombstones(response.tombstones)) tombstones.set(tombstone.relPath, tombstone);
        if (files.size + subdirs.size + tombstones.size > DIRECTORY_LIST_MAX_ENTRIES) throw new AgentStoreDirectoryListingError(`Agent store directory listing exceeded ${DIRECTORY_LIST_MAX_ENTRIES} entries`);
        pageToken = response.nextPageToken;
        // A store that hands back a page it already handed back would be walked forever.
        if (pageToken !== "" && seenPageTokens.has(pageToken)) throw new AgentStoreDirectoryListingError("Agent store directory listing repeated a page token");
        if (pageToken !== "") seenPageTokens.add(pageToken);
      } while (pageToken !== "");
      return {
        files: [...files.values()].sort((left, right) => left.relPath.localeCompare(right.relPath)),
        subdirs: [...subdirs].sort(),
        tombstones: [...tombstones.values()].sort((left, right) => left.relPath.localeCompare(right.relPath)),
        listingComplete: true,
      };
    } catch (error) {
      throw mapConnectError(error);
    }
  }

  /** One write instruction, matched to the file that asked for it. */
  private readWriteInstruction(args: { readonly instruction: AgentStoreRemoteWriteInstruction; readonly requested: AgentStoreWriteFile | undefined; readonly shaByRelPath: Map<string, string> }): AgentStoreWriteInstruction {
    const relPath = args.instruction.relPath;
    let sha = args.requested?.sha;
    try {
      sha = args.shaByRelPath.get(normalizeRelPath(relPath)) ?? sha;
    } catch {
      // The path is validated below, by the sha it has to match.
    }
    if (sha === undefined) throw new Error(`BCS presign write response missing requested file: ${relPath}`);
    return {
      relPath,
      sha,
      url: args.instruction.url,
      headers: { ...args.instruction.headers },
      expiresAtMs: args.instruction.expiresAtMs,
      ...(args.instruction.multipart === undefined ? {} : { multipart: mapMultipartWriteInstruction(args.instruction.multipart) }),
      ...(args.instruction.primaryPreconditionFailed ? { primaryPreconditionFailed: true } : {}),
      ...(args.instruction.lockRedirect === undefined ? {} : { lockRedirect: { conflictRelPath: args.instruction.lockRedirect.conflictRelPath, lockExpiresAtMs: args.instruction.lockRedirect.lockExpiresAtMs } }),
      ...(args.instruction.conflict === undefined ? {} : { conflict: mapConflictWriteInstruction(args.instruction.conflict) }),
    };
  }

  /** A call carries the store's token, the caller's signal, and this transport's own deadline. */
  private buildCallOptions(base: AgentStoreRpcCallOptions | undefined): { readonly options: AgentStoreRpcCallOptions | undefined; readonly timeoutSignal: AbortSignal | undefined } {
    if (this.rpcTimeoutMs <= 0) return { options: base, timeoutSignal: undefined };
    const timeoutSignal = AbortSignal.timeout(this.rpcTimeoutMs);
    const signal = base?.signal === undefined ? timeoutSignal : AbortSignal.any([base.signal, timeoutSignal]);
    return { options: { ...base, timeoutMs: this.rpcTimeoutMs, signal }, timeoutSignal };
  }

  private async invokeRpc<T>(invoke: (options: AgentStoreRpcCallOptions | undefined) => Promise<T>, base?: AgentStoreRpcCallOptions): Promise<T> {
    const { options, timeoutSignal } = this.buildCallOptions(base);
    return rejectWhenAborted(invoke(options), { signal: options?.signal, timeoutSignal });
  }
}

function normalizeRpcTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return DEFAULT_RPC_TIMEOUT_MS;
  return Math.floor(value);
}

/** A call that the caller stopped, or that ran past its deadline, is answered as the store's own error would be. */
function rejectWhenAborted<T>(promise: Promise<T>, args: { readonly signal: AbortSignal | undefined; readonly timeoutSignal: AbortSignal | undefined }): Promise<T> {
  if (args.signal === undefined) return promise;
  if (args.signal.aborted) return Promise.reject(rpcAbortError(args));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(rpcAbortError(args));
    };
    const cleanup = () => args.signal?.removeEventListener("abort", onAbort);
    args.signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        // An error that looks like an abort, on a call whose deadline expired, is the deadline's.
        if (args.timeoutSignal?.aborted === true && isAbortShapedRpcError(error)) reject(rpcDeadlineExceededError(args.timeoutSignal));
        else reject(error);
      },
    );
  });
}

function rpcAbortError(args: { readonly signal: AbortSignal | undefined; readonly timeoutSignal: AbortSignal | undefined }): ConnectError {
  if (args.timeoutSignal?.aborted === true) return rpcDeadlineExceededError(args.timeoutSignal);
  if (args.signal === undefined) return new ConnectError("agent store RPC canceled", Code.Canceled);
  const reason = args.signal.reason;
  if (reason instanceof ConnectError) return reason;
  if (reason instanceof Error && reason.name === "AbortError") return new ConnectError(reason.message, Code.Canceled);
  return new ConnectError(reason instanceof Error && reason.message.length > 0 ? reason.message : "agent store RPC canceled", Code.Canceled);
}

function rpcDeadlineExceededError(signal: AbortSignal): ConnectError {
  const reason = signal.reason;
  if (reason instanceof ConnectError) return reason;
  return new ConnectError(reason instanceof Error && reason.message.length > 0 ? reason.message : "agent store RPC deadline exceeded", Code.DeadlineExceeded);
}

function isAbortShapedRpcError(error: unknown): boolean {
  return (error instanceof Error && error.name === "AbortError") || (error instanceof ConnectError && (error.code === Code.Canceled || error.code === Code.DeadlineExceeded));
}

function normalizeTombstones(tombstones: readonly AgentStoreTombstone[]): AgentStoreTombstone[] {
  return tombstones.map((tombstone) => ({
    relPath: normalizeHarnessRelPath(tombstone.relPath),
    tombstoneEtag: normalizeS3Etag(tombstone.tombstoneEtag),
    deletedAtMs: tombstone.deletedAtMs,
  }));
}

function agentStoreCallOptions(token: string, signal: AbortSignal | undefined): AgentStoreRpcCallOptions {
  return { headers: { [AGENT_STORE_TOKEN_HEADER]: token }, ...(signal === undefined ? {} : { signal }) };
}

/** A delete outcome in Slate's status vocabulary, with paths and tags normalized for callers. */
function deleteOutcomeOf(result: AgentStoreDeleteOutcome): AgentStoreDeleteOutcome {
  const relPath = normalizeHarnessRelPath(result.relPath);
  const tombstoneEtag = normalizeS3Etag(result.tombstoneEtag ?? "");
  switch (result.status) {
    case "deleted":
      return { relPath, status: "deleted", tombstoneEtag };
    case "already_deleted":
      return { relPath, status: "already_deleted", ...(tombstoneEtag.length === 0 ? {} : { tombstoneEtag }) };
    case "conflict": {
      const currentEtag = normalizeS3Etag(result.currentEtag ?? "");
      return { relPath, status: "conflict", ...(currentEtag.length === 0 ? {} : { currentEtag }) };
    }
    case "unspecified":
      throw new Error(`BCS delete returned UNSPECIFIED status for ${relPath}`);
    default:
      throw new Error(`BCS delete returned an unknown status for ${relPath}: ${result.status}`);
  }
}

function mapConflictWriteInstruction(instruction: AgentStoreRemoteWriteInstruction): NonNullable<AgentStoreWriteInstruction["conflict"]> {
  return {
    relPath: instruction.relPath,
    url: instruction.url,
    headers: { ...instruction.headers },
    expiresAtMs: instruction.expiresAtMs,
    ...(instruction.multipart === undefined ? {} : { multipart: mapMultipartWriteInstruction(instruction.multipart) }),
  };
}

function mapMultipartWriteInstruction(instruction: AgentStoreRemoteMultipartWriteInstruction): AgentStoreMultipartWriteInstruction {
  if (instruction.context === undefined) throw new AgentStoreProtocolError("BCS multipart write instruction is missing context");
  return {
    context: copyMultipartContext(instruction.context),
    parts: instruction.parts.map((part) => ({ ...part, headers: { ...part.headers } })),
    partUrlsExpiresAtMs: instruction.partUrlsExpiresAtMs,
  };
}

function copyMultipartContext(context: AgentStoreMultipartContext): AgentStoreMultipartContext {
  const precondition = context.precondition;
  return {
    ...context,
    precondition: precondition.case === "baseEtag"
      ? { case: "baseEtag", value: precondition.value }
      : precondition.case === "expectAbsent"
        ? { case: "expectAbsent", value: precondition.value }
        : { case: undefined },
  };
}

/**
 * The answers to a multipart call, put back in the order the inputs were given: every input has to be answered exactly
 * once, by an answer that names the same file, or the store answered about something nobody asked about.
 */
function correlateMultipartResults<TResult, TInput extends { readonly context: AgentStoreMultipartContext }>(args: {
  readonly kind: "complete" | "abort";
  readonly inputs: readonly TInput[];
  readonly results: readonly AgentStoreMultipartRpcResult[];
  readonly map: (args: { readonly result: AgentStoreMultipartRpcResult; readonly relPath: string }) => TResult | undefined;
}): readonly TResult[] {
  const ordered: (TResult | undefined)[] = Array.from({ length: args.inputs.length });
  for (const result of args.results) {
    const inputIndex = validateMultipartResultIndex({ inputCount: args.inputs.length, inputIndex: result.inputIndex, kind: args.kind });
    if (ordered[inputIndex] !== undefined) throw new AgentStoreProtocolError(`BCS multipart ${args.kind} response repeated inputIndex ${inputIndex}`);
    const relPath = normalizeMultipartResponseRelPath({ relPath: result.relPath, inputIndex, kind: args.kind });
    if (relPath !== normalizeRelPath(args.inputs[inputIndex]?.context.relPath ?? "")) throw new AgentStoreProtocolError(`BCS multipart ${args.kind} response relPath mismatch at inputIndex ${inputIndex}`);
    ordered[inputIndex] = args.map({ result, relPath });
  }
  return requireCompleteMultipartResultSet({ ordered, kind: args.kind });
}

function validateMultipartResultIndex(args: { readonly inputCount: number; readonly inputIndex: number; readonly kind: string }): number {
  if (!Number.isInteger(args.inputIndex) || args.inputIndex < 0 || args.inputIndex >= args.inputCount) throw new AgentStoreProtocolError(`BCS multipart ${args.kind} response returned out-of-range inputIndex ${args.inputIndex}`);
  return args.inputIndex;
}

function normalizeMultipartResponseRelPath(args: { readonly relPath: string; readonly inputIndex: number; readonly kind: string }): string {
  try {
    return normalizeRelPath(args.relPath);
  } catch {
    throw new AgentStoreProtocolError(`BCS multipart ${args.kind} response returned an invalid relPath at inputIndex ${args.inputIndex}`);
  }
}

function requireCompleteMultipartResultSet<T>(args: { readonly ordered: readonly (T | undefined)[]; readonly kind: string }): readonly T[] {
  const output: T[] = [];
  for (const [index, result] of args.ordered.entries()) {
    if (result === undefined) throw new AgentStoreProtocolError(`BCS multipart ${args.kind} response missing result for inputIndex ${index}`);
    output.push(result);
  }
  return output;
}

function mapMultipartCompletionResult(args: { readonly result: AgentStoreMultipartRpcResult; readonly relPath: string }): { readonly kind: "success" | "failure"; readonly relPath: string; readonly etag?: string; readonly code?: string } | undefined {
  switch (args.result.outcome.kind) {
    case "success":
      return { kind: "success", relPath: args.relPath, etag: normalizeS3Etag(args.result.outcome.etag ?? "") };
    case "failure":
      return { kind: "failure", relPath: args.relPath, code: args.result.outcome.code };
    case "unknown":
      // An outcome this transport does not know is no result, which the caller is told about as a missing one.
      return undefined;
  }
}

function mapMultipartAbortResult(args: { readonly result: AgentStoreMultipartRpcResult; readonly relPath: string }): { readonly kind: "success" | "failure"; readonly relPath: string; readonly alreadyFinished?: boolean; readonly code?: string } | undefined {
  switch (args.result.outcome.kind) {
    case "success":
      return { kind: "success", relPath: args.relPath, ...(args.result.outcome.alreadyFinished === undefined ? {} : { alreadyFinished: args.result.outcome.alreadyFinished }) };
    case "failure":
      return { kind: "failure", relPath: args.relPath, code: args.result.outcome.code };
    case "unknown":
      // An outcome this transport does not know is no result, which the caller is told about as a missing one.
      return undefined;
  }
}

function directoryListCacheKey(args: { readonly token: AgentStoreToken; readonly storeId: string; readonly relPath: string; readonly shareId?: string }): string {
  return `${listingTargetKey(args)}\0${args.token.token}\0${normalizeHarnessRelPath(args.relPath)}`;
}
function completeFlatListCacheKey(args: { readonly token: AgentStoreToken; readonly storeId: string; readonly shareId?: string }): string {
  return `${listingTargetKey(args)}\0${args.token.token}`;
}
function listingTargetKey(args: { readonly storeId: string; readonly shareId?: string }): string {
  return args.shareId !== undefined ? `share:${args.shareId}` : `self:${args.storeId}`;
}
/** Every store a change touches: the store itself, and the share it was read through. */
function listingTargets(args: { readonly storeId: string; readonly shareId?: string }): Set<string> {
  const targets = new Set([`self:${args.storeId}`]);
  if (args.shareId !== undefined) targets.add(`share:${args.shareId}`);
  return targets;
}
/** A cache key starts with the target it was kept for. */
function targetOfCacheKey(key: string): string {
  return key.split("\0", 1)[0] ?? "";
}
function normalizeHarnessRelPath(relPath: string): string {
  return relPath.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
}
function isUncacheableAllUnsafeListing(listing: AgentStoreListing): boolean {
  return (listing.skippedUnsafeEntries ?? 0) > 0 && listing.files.length === 0;
}
function mapConnectError(error: unknown): unknown {
  if (error instanceof ConnectError && (error.code === Code.Unauthenticated || error.code === Code.PermissionDenied)) return new AgentStoreUnauthorizedError(error.message);
  return error;
}
