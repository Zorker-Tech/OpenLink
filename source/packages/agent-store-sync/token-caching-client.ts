/**
 * The store's transport, with a token kept in front of it.
 *
 * Every call the sync engine makes asks this client for a token first, and this client decides whether the store has to
 * be asked for one at all: a token that is not near its expiry answers from here, two calls that arrive together share
 * the one mint in flight, and a mint that was refused is remembered so that a store that will not have this account is
 * not asked again on every call. A call the store refused *because of the token* is retried once with a fresh one; any
 * other refusal is the caller's own error.
 *
 * The token a call is made with belongs to the store it names — the first store the token is scoped to — and the share
 * a call is made through keeps its own token, so a share and the agent behind it never answer for each other.
 */
import { isAgentStoreId, isCloudAgentStoreId, isValidBareUuid, parseTeamAgentStoreSourceId, parseUserAgentStoreSourceId } from "../constants/agent-store-ids.ts";
import { AgentStoreUnauthorizedError } from "./bcs-client.ts";
import { BackoffScheduler } from "./backoff-scheduler.ts";
import { mintFailureIsCacheable, syncIsDisabledForAccount } from "./connect-errors.ts";
import type { AgentStoreMintTarget, AgentStoreMultipartWriteAbort, AgentStoreMultipartWriteCompletion, AgentStoreSourceKind, AgentStoreToken, AgentStoreWriteFile } from "./bcs-transport.ts";

const DEFAULT_REFRESH_BUFFER_MS = 60_000;
const DEFAULT_MINT_NEGATIVE_CACHE_BASE_MS = 30_000;
const DEFAULT_MINT_NEGATIVE_CACHE_MAX_MS = 15 * 60_000;
/** A stand-down lasts until something else says otherwise, which is why it is not a time at all. */
const SYNC_DISABLED_UNTIL_MS = Number.POSITIVE_INFINITY;

/** What the host is told about the tokens this client keeps, if it asked to be told. */
interface TokenMetrics {
  tokenMinted(event: { readonly agentId: string; readonly reason: "cold" | "near_expiry" | "after_unauthorized" }): void;
  tokenRefreshUnauthorized(event: { readonly agentId: string; readonly op: string }): void;
  tokenMintNegativeCached?(event: { readonly agentId: string; readonly untilMs: number }): void;
  tokenMintFailureCached?(event: { readonly agentId: string; readonly kind: "stand_down" | "backoff" }): void;
}

const NOOP_METRICS: TokenMetrics = { tokenMinted() {}, tokenRefreshUnauthorized() {} };

/** The transport as this client reads it: what it needs, and the parts a transport may not have. */
export interface TokenCachingAgentStoreTransport {
  mintToken(target: AgentStoreMintTarget): Promise<AgentStoreToken>;
  listFiles(args: Record<string, unknown>): Promise<unknown>;
  presignReads(args: Record<string, unknown>): Promise<unknown>;
  presignWrites(args: Record<string, unknown>): Promise<unknown>;
  deleteFiles?(args: Record<string, unknown>): Promise<unknown>;
  completeMultipartWrites?(args: Record<string, unknown>): Promise<unknown>;
  abortMultipartWrites?(args: Record<string, unknown>): Promise<unknown>;
  invalidateListCache?(args: { readonly storeId: string; readonly shareId?: string }): void;
}

export interface TokenCachingAgentStoreClientOptions {
  readonly metrics?: TokenMetrics;
  readonly now?: () => number;
  readonly refreshBufferMs?: number;
  readonly mintNegativeCacheBaseMs?: number;
  readonly mintNegativeCacheMaxMs?: number;
  readonly onSyncDisabledMint?: (event: { readonly agentId: string; readonly message: string }) => void | Promise<void>;
}

interface OperationRequest {
  readonly agentId: string;
  readonly shareId?: string;
  readonly mintSourceKind?: AgentStoreSourceKind;
  readonly signal?: AbortSignal;
}

/** A mint that was refused, remembered with the delay before it may be tried again. */
interface NegativeMintEntry {
  readonly error: unknown;
  readonly untilMs: number;
  readonly backoff: BackoffScheduler;
}

export class TokenCachingAgentStoreClient {
  private readonly transport: TokenCachingAgentStoreTransport;
  private readonly tokens = new Map<string, AgentStoreToken>();
  private readonly inFlightMints = new Map<string, Promise<AgentStoreToken>>();
  private readonly mintNegativeCache = new Map<string, NegativeMintEntry>();
  private readonly metrics: TokenMetrics;
  private readonly now: () => number;
  private readonly refreshBufferMs: number;
  private readonly mintNegativeCacheBaseMs: number;
  private readonly mintNegativeCacheMaxMs: number;
  private readonly onSyncDisabledMint: TokenCachingAgentStoreClientOptions["onSyncDisabledMint"];

  declare readonly completeMultipartWrites?: (request: OperationRequest & { readonly completions: readonly AgentStoreMultipartWriteCompletion[] }) => Promise<unknown>;
  declare readonly abortMultipartWrites?: (request: OperationRequest & { readonly uploads: readonly AgentStoreMultipartWriteAbort[] }) => Promise<unknown>;

  constructor(transport: TokenCachingAgentStoreTransport, options: TokenCachingAgentStoreClientOptions = {}) {
    this.transport = transport;
    this.metrics = options.metrics ?? NOOP_METRICS;
    this.now = options.now ?? Date.now;
    this.refreshBufferMs = options.refreshBufferMs ?? DEFAULT_REFRESH_BUFFER_MS;
    this.mintNegativeCacheBaseMs = options.mintNegativeCacheBaseMs ?? DEFAULT_MINT_NEGATIVE_CACHE_BASE_MS;
    this.mintNegativeCacheMaxMs = options.mintNegativeCacheMaxMs ?? DEFAULT_MINT_NEGATIVE_CACHE_MAX_MS;
    this.onSyncDisabledMint = options.onSyncDisabledMint;

    // The two halves of a multipart write are only there when the transport has them.
    const completeMultipartWrites = transport.completeMultipartWrites;
    if (completeMultipartWrites !== undefined) {
      this.completeMultipartWrites = (request) =>
        this.callWithRefresh({
          cacheKey: request.agentId,
          mintAgentId: request.agentId,
          opName: "completeMultipartWrites",
          ...optionalOperationFields(request),
          op: (token, storeId) => completeMultipartWrites.call(transport, { completions: request.completions, storeId, token, signal: request.signal }),
        });
    }
    const abortMultipartWrites = transport.abortMultipartWrites;
    if (abortMultipartWrites !== undefined) {
      this.abortMultipartWrites = (request) =>
        this.callWithRefresh({
          cacheKey: request.agentId,
          mintAgentId: request.agentId,
          opName: "abortMultipartWrites",
          ...optionalOperationFields(request),
          op: (token, storeId) => abortMultipartWrites.call(transport, { uploads: request.uploads, storeId, token, signal: request.signal }),
        });
    }
  }

  async listFiles(request: OperationRequest & { readonly relPath: string }): Promise<unknown> {
    return await this.callWithRefresh({
      cacheKey: tokenCacheKey(request),
      mintAgentId: request.agentId,
      opName: "listFiles",
      ...optionalOperationFields(request),
      op: (token, storeId) => this.transport.listFiles({ relPath: request.relPath, shareId: request.shareId, storeId, token, signal: request.signal }),
    });
  }

  async presignReads(request: OperationRequest & { readonly relPaths: readonly string[] }): Promise<unknown> {
    return await this.callWithRefresh({
      cacheKey: tokenCacheKey(request),
      mintAgentId: request.agentId,
      opName: "presignReads",
      ...optionalOperationFields(request),
      op: (token, storeId) => this.transport.presignReads({ relPaths: request.relPaths, shareId: request.shareId, storeId, token, signal: request.signal }),
    });
  }

  async presignWrites(request: OperationRequest & { readonly files: readonly AgentStoreWriteFile[] }): Promise<unknown> {
    return await this.callWithRefresh({
      cacheKey: request.agentId,
      mintAgentId: request.agentId,
      opName: "presignWrites",
      ...optionalOperationFields(request),
      op: (token, storeId) => this.transport.presignWrites({ files: request.files, storeId, token, signal: request.signal }),
    });
  }

  async deleteFiles(request: OperationRequest & { readonly files: readonly { readonly relPath: string; readonly baseEtag: string; readonly mutationId?: string }[] }): Promise<unknown> {
    const deleteFiles = this.transport.deleteFiles?.bind(this.transport);
    if (deleteFiles === undefined) throw new Error("TokenCachingAgentStoreClient: transport does not support deleteFiles");
    return await this.callWithRefresh({
      cacheKey: request.agentId,
      mintAgentId: request.agentId,
      opName: "deleteFiles",
      ...optionalOperationFields(request),
      op: (token, storeId) => deleteFiles({ files: request.files, storeId, token, signal: request.signal }),
    });
  }

  /** Forgetting a listing needs the store the token names; without a token there is nothing to forget. */
  invalidateListCache(request: OperationRequest): void {
    const token = this.tokens.get(tokenCacheKey(request));
    if (token === undefined) return;
    const storeId = token.storeIds[0];
    if (storeId === undefined || storeId === "") return;
    this.transport.invalidateListCache?.({ storeId, ...(request.shareId === undefined ? {} : { shareId: request.shareId }) });
  }

  /** One call: with the token at hand, and once more with a fresh one if the store refused that token. */
  private async callWithRefresh(args: {
    readonly cacheKey: string;
    readonly mintAgentId: string;
    readonly shareId?: string;
    readonly mintSourceKind?: AgentStoreSourceKind;
    readonly opName: string;
    readonly signal?: AbortSignal;
    readonly op: (token: AgentStoreToken, storeId: string) => Promise<unknown>;
  }): Promise<unknown> {
    const token = await this.getValidToken({ cacheKey: args.cacheKey, mintAgentId: args.mintAgentId, ...optionalOperationFields(args) });
    try {
      return await args.op(token, storeIdOf(token));
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
      // The token itself was refused: it is dropped, a fresh one is minted, and the call is made once more.
      this.metrics.tokenRefreshUnauthorized({ agentId: args.mintAgentId, op: args.opName });
      this.tokens.delete(args.cacheKey);
      const freshToken = await this.getValidToken({ cacheKey: args.cacheKey, mintAgentId: args.mintAgentId, mintReason: "after_unauthorized", ...optionalOperationFields(args) });
      return await args.op(freshToken, storeIdOf(freshToken));
    }
  }

  /**
   * The token to call with: what is kept when it is not near its expiry, the mint already in flight when there is one,
   * and otherwise a mint of its own — after checking that the store has not already refused to mint for this account.
   */
  private async getValidToken(args: {
    readonly cacheKey: string;
    readonly mintAgentId: string;
    readonly shareId?: string;
    readonly mintSourceKind?: AgentStoreSourceKind;
    readonly mintReason?: "after_unauthorized";
    readonly signal?: AbortSignal;
  }): Promise<AgentStoreToken> {
    this.throwIfMintRefused(args);
    const existing = this.tokens.get(args.cacheKey);
    if (existing !== undefined && existing.expiresAtMs - this.now() > this.refreshBufferMs) return existing;
    let pending = this.inFlightMints.get(args.cacheKey);
    if (pending === undefined) {
      // The store may have been refused while this call was waiting for another mint.
      this.throwIfMintRefused(args);
      const reason = args.mintReason ?? (existing === undefined ? "cold" : "near_expiry");
      pending = this.transport
        .mintToken(mintTargetFor({ agentId: args.mintAgentId, ...optionalMintTargetFields(args) }))
        .then(
          (token) => {
            this.mintNegativeCache.delete(args.cacheKey);
            this.tokens.set(args.cacheKey, token);
            this.metrics.tokenMinted({ agentId: args.mintAgentId, reason });
            return token;
          },
          (error) => {
            this.rememberMintFailure({ cacheKey: args.cacheKey, agentId: args.mintAgentId, error });
            throw error;
          },
        )
        .finally(() => {
          this.inFlightMints.delete(args.cacheKey);
        });
      this.inFlightMints.set(args.cacheKey, pending);
    }
    return await awaitWithAbortSignal(pending, args.signal);
  }

  private throwIfMintRefused(args: { readonly cacheKey: string; readonly mintAgentId: string }): void {
    const refused = this.mintNegativeCache.get(args.cacheKey);
    if (refused === undefined) return;
    if (this.now() >= refused.untilMs) {
      this.mintNegativeCache.delete(args.cacheKey);
      return;
    }
    this.metrics.tokenMintNegativeCached?.({ agentId: args.mintAgentId, untilMs: refused.untilMs });
    throw refused.error;
  }

  /**
   * What a refused mint means: a store that will not have this account stands down until something else changes, and a
   * refusal that may pass is waited out with a growing delay.
   */
  private rememberMintFailure(args: { readonly cacheKey: string; readonly agentId: string; readonly error: unknown }): void {
    if (syncIsDisabledForAccount(args.error)) {
      const backoff = this.mintNegativeCache.get(args.cacheKey)?.backoff ?? newBackoffScheduler({ baseMs: this.mintNegativeCacheBaseMs, maxMs: this.mintNegativeCacheMaxMs });
      this.mintNegativeCache.set(args.cacheKey, { error: args.error, untilMs: SYNC_DISABLED_UNTIL_MS, backoff });
      this.metrics.tokenMintFailureCached?.({ agentId: args.agentId, kind: "stand_down" });
      this.notifySyncDisabledMint({ agentId: args.agentId, message: args.error instanceof Error ? args.error.message : String(args.error) });
      return;
    }
    if (!mintFailureIsCacheable(args.error)) return;
    const backoff = this.mintNegativeCache.get(args.cacheKey)?.backoff ?? newBackoffScheduler({ baseMs: this.mintNegativeCacheBaseMs, maxMs: this.mintNegativeCacheMaxMs });
    this.mintNegativeCache.set(args.cacheKey, { error: args.error, untilMs: this.now() + backoff.recordFailure(), backoff });
    this.metrics.tokenMintFailureCached?.({ agentId: args.agentId, kind: "backoff" });
  }

  /** Telling the host is best effort: it neither changes the stand-down nor waits for the host. */
  private notifySyncDisabledMint(event: { readonly agentId: string; readonly message: string }): void {
    if (this.onSyncDisabledMint === undefined) return;
    try {
      const result = this.onSyncDisabledMint(event);
      if (result !== undefined && result !== null && typeof (result as Promise<void>).then === "function") (result as Promise<void>).then(() => undefined, () => undefined);
    } catch {}
  }
}

function newBackoffScheduler(args: { readonly baseMs: number; readonly maxMs: number }): BackoffScheduler {
  return new BackoffScheduler({ baseDelayMs: args.baseMs, maxDelayMs: args.maxMs, jitter: 0.2 });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

/** Waiting for a mint is the caller's to stop, with the reason they stopped it for. */
function awaitWithAbortSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** The store a token is scoped to; a token that names none cannot be called with. */
function storeIdOf(token: AgentStoreToken): string {
  const storeId = token.storeIds[0];
  if (storeId === undefined || storeId === "") throw new AgentStoreUnauthorizedError("Agent store token did not include a scoped store id");
  return storeId;
}

function tokenCacheKey(request: { readonly agentId: string; readonly shareId?: string }): string {
  return request.shareId ?? request.agentId;
}

function optionalOperationFields(value: { readonly shareId?: string; readonly mintSourceKind?: AgentStoreSourceKind; readonly signal?: AbortSignal }): {
  readonly shareId?: string;
  readonly mintSourceKind?: AgentStoreSourceKind;
  readonly signal?: AbortSignal;
} {
  return {
    ...(value.shareId === undefined ? {} : { shareId: value.shareId }),
    ...(value.mintSourceKind === undefined ? {} : { mintSourceKind: value.mintSourceKind }),
    ...(value.signal === undefined ? {} : { signal: value.signal }),
  };
}

function optionalMintTargetFields(value: { readonly shareId?: string; readonly mintSourceKind?: AgentStoreSourceKind }): {
  readonly shareId?: string;
  readonly sourceKind?: AgentStoreSourceKind;
} {
  return {
    ...(value.shareId === undefined ? {} : { shareId: value.shareId }),
    ...(value.mintSourceKind === undefined ? {} : { sourceKind: value.mintSourceKind }),
  };
}

/** What the id a call names actually is, which is what the store has to be asked for. */
function mintTargetFor(args: { readonly agentId: string; readonly shareId?: string; readonly sourceKind?: AgentStoreSourceKind }): AgentStoreMintTarget {
  if (args.shareId !== undefined) return { kind: "share", shareId: args.shareId };
  if (args.sourceKind !== undefined) return { kind: "source", sourceKind: args.sourceKind, sourceId: args.agentId };
  if (isAgentStoreId(args.agentId)) return { kind: "store", storeId: args.agentId };
  if (isCloudAgentStoreId(args.agentId)) return { kind: "source", sourceKind: "cloud", sourceId: args.agentId };
  if (isValidBareUuid(args.agentId)) return { kind: "source", sourceKind: "local", sourceId: args.agentId };
  if (parseUserAgentStoreSourceId(args.agentId) !== undefined) return { kind: "source", sourceKind: "user", sourceId: args.agentId };
  if (parseTeamAgentStoreSourceId(args.agentId) !== undefined) return { kind: "source", sourceKind: "team", sourceId: args.agentId };
  throw new AgentStoreUnauthorizedError("Agent store target is not a valid store or source id");
}

/** A refusal is read from its own kind, from a status, and from the codes the transport's errors carry. */
function isUnauthorized(error: unknown): boolean {
  if (error instanceof AgentStoreUnauthorizedError) return true;
  if (typeof error !== "object" || error === null) return false;
  const status = "status" in error ? (error as { readonly status?: unknown }).status : undefined;
  if (status === 401 || status === 403) return true;
  const code = "code" in error ? (error as { readonly code?: unknown }).code : undefined;
  return code === 7 || code === 16 || code === "PermissionDenied" || code === "Unauthenticated" || code === "PERMISSION_DENIED" || code === "UNAUTHENTICATED";
}
