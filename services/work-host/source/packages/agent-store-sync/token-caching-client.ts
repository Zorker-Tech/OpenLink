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
import { AgentStoreUnauthorizedError } from "./bcs-client.ts";
import { AgentStoreTokenCache } from "./agent-store-token-cache.ts";
import { resolveAgentStoreMintTarget } from "./agent-store-target-resolution.ts";
import type {
  AgentStoreMultipartWriteAbort,
  AgentStoreMultipartWriteCompletion,
  AgentStoreOperationsPort,
  AgentStoreSourceKind,
  AgentStoreToken,
  AgentStoreWriteFile,
} from "./agent-store-sync-contracts.ts";
import type { AgentStoreTokenCacheOptions } from "./agent-store-token-cache.ts";

export type TokenCachingAgentStoreTransport = AgentStoreOperationsPort
export type TokenCachingAgentStoreClientOptions = Omit<AgentStoreTokenCacheOptions, "mintToken">

interface OperationRequest {
  readonly agentId: string;
  readonly shareId?: string;
  readonly mintSourceKind?: AgentStoreSourceKind;
  readonly signal?: AbortSignal;
}

/** A mint that was refused, remembered with the delay before it may be tried again. */
export class TokenCachingAgentStoreClient {
  private readonly transport: TokenCachingAgentStoreTransport;
  private readonly tokenCache: AgentStoreTokenCache;

  declare readonly completeMultipartWrites?: (request: OperationRequest & { readonly completions: readonly AgentStoreMultipartWriteCompletion[] }) => Promise<unknown>;
  declare readonly abortMultipartWrites?: (request: OperationRequest & { readonly uploads: readonly AgentStoreMultipartWriteAbort[] }) => Promise<unknown>;

  constructor(transport: TokenCachingAgentStoreTransport, options: TokenCachingAgentStoreClientOptions = {}) {
    this.transport = transport;
    this.tokenCache = new AgentStoreTokenCache({
      mintToken: (target) => transport.mintToken(target),
      ...options,
    });

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
    const token = this.tokenCache.getForInvalidation(tokenCacheKey(request));
    if (token === undefined) return;
    const storeId = token.storeIds[0];
    if (storeId === undefined || storeId === "") return;
    this.transport.invalidateListCache?.({ storeId, ...(request.shareId === undefined ? {} : { shareId: request.shareId }) });
  }

  /** One call: with the token at hand, and once more with a fresh one if the store refused that token. */
  private callWithRefresh(args: {
    readonly cacheKey: string;
    readonly mintAgentId: string;
    readonly shareId?: string;
    readonly mintSourceKind?: AgentStoreSourceKind;
    readonly opName: string;
    readonly signal?: AbortSignal;
    readonly op: (token: AgentStoreToken, storeId: string) => Promise<unknown>;
  }): Promise<unknown> {
    return this.tokenCache.run({
      cacheKey: args.cacheKey,
      agentId: args.mintAgentId,
      target: resolveAgentStoreMintTarget({ agentId: args.mintAgentId, ...optionalMintTargetFields(args) }),
      operationName: args.opName,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    }, token => args.op(token, storeIdOf(token)));
  }
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
