import { createClient, type CallOptions, type Client, type Transport } from "@connectrpc/connect";
import {
  AbortAgentStoreMultipartWritesRequest,
  AgentStoreDeleteFileStatus,
  AgentStoreDirectoryListingMode,
  AgentStoreMultipartOperationFailureCode,
  AgentStoreSourceKind as ProtoAgentStoreSourceKind,
  AgentStoreSourceRef,
  AgentStoreWriteFileEntry,
  CompleteAgentStoreMultipartWritesRequest,
  AgentStoreDeleteFileEntry,
  DeleteAgentStoreFilesRequest,
  ListAgentStoreDirectoryRequest,
  MintAgentStoreTokenRequest,
  PresignAgentStoreReadsRequest,
  PresignAgentStoreWritesRequest,
  AgentStoreMultipartUploadPartDescriptor,
  AgentStoreMultipartUploadContext,
  AgentStoreMultipartWriteCompletion,
  AgentStoreMultipartUploadedPart,
  AgentStoreMultipartWriteAbort,
} from "../proto/generated/aiserver/v1/background_composer_pb.ts";
import { BackgroundComposerService } from "../proto/generated/aiserver/v1/background_composer_connect.ts";
import type {
  AgentStoreCloudClient,
  AgentStoreDeleteOutcome,
  AgentStoreDirectoryPage,
  AgentStoreDirectoryQuery,
  AgentStoreMultipartContext,
  AgentStoreMultipartRpcResult,
  AgentStoreMultipartWriteAbort as SlateMultipartWriteAbort,
  AgentStoreMultipartWriteCompletion as SlateMultipartWriteCompletion,
  AgentStoreMintTarget,
  AgentStoreRemoteMultipartWriteInstruction,
  AgentStoreRemoteWriteInstruction,
  AgentStoreRpcCallOptions,
  AgentStoreSourceKind,
  AgentStoreWriteFile,
} from "../../../packages/agent-store-sync/agent-store-sync-contracts.ts";
import { normalizeS3Etag } from "../../../packages/agent-store-sync/etag.ts";

/** Raw RPC methods accepted only at the interop boundary, including in transport fakes. */
export interface BcsAgentStoreRpcClient {
  mintAgentStoreToken(request: unknown, options?: CallOptions): Promise<any>;
  listAgentStoreDirectory(request: unknown, options?: CallOptions): Promise<any>;
  presignAgentStoreReads(request: unknown, options?: CallOptions): Promise<any>;
  presignAgentStoreWrites(request: unknown, options?: CallOptions): Promise<any>;
  completeAgentStoreMultipartWrites(request: unknown, options?: CallOptions): Promise<any>;
  abortAgentStoreMultipartWrites(request: unknown, options?: CallOptions): Promise<any>;
  deleteAgentStoreFiles(request: unknown, options?: CallOptions): Promise<any>;
}

function rpcOptions(options: AgentStoreRpcCallOptions | undefined): CallOptions | undefined {
  return options as CallOptions | undefined;
}

function sourceKindToProto(kind: AgentStoreSourceKind): ProtoAgentStoreSourceKind {
  switch (kind) {
    case "cloud": return ProtoAgentStoreSourceKind.CLOUD;
    case "local": return ProtoAgentStoreSourceKind.LOCAL;
    case "user": return ProtoAgentStoreSourceKind.USER;
    case "team": return ProtoAgentStoreSourceKind.TEAM;
    case "automation": return ProtoAgentStoreSourceKind.AUTOMATION;
  }
}

function mintRequest(target: AgentStoreMintTarget): MintAgentStoreTokenRequest {
  switch (target.kind) {
    case "share": return new MintAgentStoreTokenRequest({ shareId: target.shareId });
    case "store": return new MintAgentStoreTokenRequest({ storeId: target.storeId });
    case "source": return new MintAgentStoreTokenRequest({ source: new AgentStoreSourceRef({ kind: sourceKindToProto(target.sourceKind), sourceId: target.sourceId }) });
  }
}

function mapMultipartContext(context: any): AgentStoreMultipartContext {
  const precondition = context.precondition;
  let mappedPrecondition: AgentStoreMultipartContext["precondition"];
  switch (precondition?.case) {
    case "baseEtag": mappedPrecondition = { case: "baseEtag", value: precondition.value }; break;
    case "expectAbsent": mappedPrecondition = { case: "expectAbsent", value: precondition.value }; break;
    default: mappedPrecondition = { case: undefined };
  }
  return {
    uploadId: context.uploadId,
    storeId: context.storeId,
    relPath: context.relPath,
    sizeBytes: Number(context.sizeBytes),
    sha: context.sha,
    expectedPartCount: context.expectedPartCount,
    precondition: mappedPrecondition,
    sessionId: context.sessionId,
  };
}

function preconditionToProto(precondition: AgentStoreMultipartContext["precondition"]): AgentStoreMultipartUploadContext["precondition"] {
  switch (precondition.case) {
    case "baseEtag": return { case: "baseEtag", value: precondition.value };
    case "expectAbsent": return { case: "expectAbsent", value: precondition.value };
    default: return { case: undefined };
  }
}

function multipartContextToProto(context: AgentStoreMultipartContext): AgentStoreMultipartUploadContext {
  return new AgentStoreMultipartUploadContext({
    uploadId: context.uploadId,
    storeId: context.storeId,
    relPath: context.relPath,
    sizeBytes: BigInt(context.sizeBytes),
    sha: context.sha,
    expectedPartCount: context.expectedPartCount,
    precondition: preconditionToProto(context.precondition),
    sessionId: context.sessionId,
  });
}

function writeFileEntry(file: AgentStoreWriteFile): AgentStoreWriteFileEntry {
  return new AgentStoreWriteFileEntry({
    relPath: file.relPath,
    sizeBytes: BigInt(file.size),
    sha: file.sha,
    ...(file.multipartParts === undefined ? {} : { multipartParts: file.multipartParts.map((part) => new AgentStoreMultipartUploadPartDescriptor({ partNumber: part.partNumber, offsetBytes: BigInt(part.offsetBytes), sizeBytes: BigInt(part.sizeBytes), checksumSha256: new Uint8Array(part.checksumSha256) })) }),
    ...(file.baseEtag !== undefined ? { precondition: { case: "baseEtag" as const, value: normalizeS3Etag(file.baseEtag) } } : file.expectAbsent === true ? { precondition: { case: "expectAbsent" as const, value: true } } : {}),
  });
}

function mapRemoteMultipartInstruction(instruction: any): AgentStoreRemoteMultipartWriteInstruction {
  return {
    ...(instruction.context === undefined ? {} : { context: mapMultipartContext(instruction.context) }),
    parts: (instruction.parts ?? []).map((part: any) => ({ partNumber: part.partNumber, url: part.url, headers: { ...part.headers }, offsetBytes: Number(part.offsetBytes), sizeBytes: Number(part.sizeBytes) })),
    partUrlsExpiresAtMs: Number(instruction.partUrlsExpiresAtMs),
  };
}

function mapRemoteWriteLocation(instruction: any) {
  return {
    relPath: instruction.relPath,
    url: instruction.url,
    headers: { ...instruction.headers },
    expiresAtMs: Number(instruction.expiresAtMs),
    ...(instruction.multipart === undefined ? {} : { multipart: mapRemoteMultipartInstruction(instruction.multipart) }),
  };
}

function mapRemoteWriteInstruction(instruction: any): AgentStoreRemoteWriteInstruction {
  return {
    ...mapRemoteWriteLocation(instruction),
    ...(instruction.primaryPreconditionFailed === true ? { primaryPreconditionFailed: true } : {}),
    ...(instruction.lockRedirect === undefined ? {} : { lockRedirect: { conflictRelPath: instruction.lockRedirect.conflictRelPath, lockExpiresAtMs: Number(instruction.lockRedirect.lockExpiresAtMs) } }),
    ...(instruction.conflict === undefined ? {} : { conflict: mapRemoteWriteLocation(instruction.conflict) }),
  };
}

function multipartFailureCode(code: number): string {
  switch (code) {
    case AgentStoreMultipartOperationFailureCode.UNSPECIFIED: return "internal";
    case AgentStoreMultipartOperationFailureCode.PRECONDITION_FAILED: return "precondition_failed";
    case AgentStoreMultipartOperationFailureCode.UPLOAD_NOT_FOUND: return "upload_not_found";
    case AgentStoreMultipartOperationFailureCode.INVALID_PARTS: return "invalid_parts";
    case AgentStoreMultipartOperationFailureCode.CHECKSUM_MISMATCH: return "checksum_mismatch";
    case AgentStoreMultipartOperationFailureCode.TRANSIENT: return "transient";
    case AgentStoreMultipartOperationFailureCode.INTERNAL: return "internal";
    case AgentStoreMultipartOperationFailureCode.RESTART_REQUIRED: return "restart_required";
    default: return "unknown";
  }
}

function multipartOutcome(outcome: any, kind: "complete" | "abort"): AgentStoreMultipartRpcResult["outcome"] {
  switch (outcome?.case) {
    case "success":
      return {
        kind: "success",
        ...(kind === "complete" ? { etag: outcome.value.etag } : { alreadyFinished: outcome.value.alreadyFinished }),
      };
    case "failure": return { kind: "failure", code: multipartFailureCode(outcome.value.code) };
    case undefined: return { kind: "failure", code: "internal" };
    default: return { kind: "unknown" };
  }
}

function multipartResults(results: readonly any[], kind: "complete" | "abort"): AgentStoreMultipartRpcResult[] {
  return results.map((result) => ({ inputIndex: result.inputIndex, relPath: result.relPath, outcome: multipartOutcome(result.outcome, kind) }));
}

function deleteStatusToSlate(status: number): string {
  switch (status) {
    case AgentStoreDeleteFileStatus.DELETED: return "deleted";
    case AgentStoreDeleteFileStatus.ALREADY_DELETED: return "already_deleted";
    case AgentStoreDeleteFileStatus.CONFLICT: return "conflict";
    case AgentStoreDeleteFileStatus.UNSPECIFIED: return "unspecified";
    default: return `unknown:${status}`;
  }
}

function deleteOutcome(result: any): AgentStoreDeleteOutcome {
  return {
    relPath: result.relPath,
    status: deleteStatusToSlate(result.status),
    ...(result.tombstoneEtag === undefined ? {} : { tombstoneEtag: result.tombstoneEtag }),
    ...(result.currentEtag === undefined ? {} : { currentEtag: result.currentEtag }),
  };
}

/** Converts the host's agent-store port calls into the generated service and projects replies back. */
export function adaptBcsAgentStoreRpcClient(client: BcsAgentStoreRpcClient): AgentStoreCloudClient {
  return {
    async mintToken(target, options) {
      const response = await client.mintAgentStoreToken(mintRequest(target), rpcOptions(options));
      return { token: response.token, expiresAtMs: Number(response.expiresAtMs), storeIds: [...(response.storeIds?.length > 0 ? response.storeIds : response.agentIds ?? [])] };
    },
    async listDirectory(query: AgentStoreDirectoryQuery, options) {
      const response = await client.listAgentStoreDirectory(new ListAgentStoreDirectoryRequest({
        ...(query.shareId === undefined ? { storeId: query.storeId } : { shareId: query.shareId }),
        relativePath: query.relativePath,
        pageSize: query.pageSize,
        pageToken: query.pageToken,
        preferCompleteFlatStore: query.preferCompleteFlatStore,
      }), rpcOptions(options));
      const files = (response.files ?? []).map((file: any) => ({ relPath: file.relPath, etag: file.etag, size: Number(file.sizeBytes), serverMtimeMs: Number(file.lastModifiedMs) }));
      const tombstones = (response.tombstones ?? []).map((entry: any) => ({ relPath: entry.relPath, tombstoneEtag: entry.tombstoneEtag, deletedAtMs: Number(entry.deletedAtMs) }));
      return response.mode === AgentStoreDirectoryListingMode.COMPLETE_FLAT_STORE
        ? { kind: "complete" as const, files, tombstones }
        : { kind: "page" as const, files, subdirs: [...(response.subdirs ?? [])], tombstones, nextPageToken: response.nextPageToken ?? "" };
    },
    async presignReads(request, options) {
      const response = await client.presignAgentStoreReads(new PresignAgentStoreReadsRequest(request.shareId !== undefined ? { shareId: request.shareId, relPaths: [...request.relPaths] } : { storeId: request.storeId, relPaths: [...request.relPaths] }), rpcOptions(options));
      return (response.instructions ?? []).map((instruction: any) => ({ relPath: instruction.relPath, url: instruction.url, expiresAtMs: Number(instruction.expiresAtMs) }));
    },
    async presignWrites(request, options) {
      const response = await client.presignAgentStoreWrites(new PresignAgentStoreWritesRequest({ storeId: request.storeId, files: request.files.map(writeFileEntry) }), rpcOptions(options));
      return (response.instructions ?? []).map(mapRemoteWriteInstruction);
    },
    async completeWrites(request, options) {
      const protoCompletions = request.completions.map((completion) => new AgentStoreMultipartWriteCompletion({ context: multipartContextToProto(completion.context), parts: completion.parts.map((part) => new AgentStoreMultipartUploadedPart({ partNumber: part.partNumber, etag: part.etag, checksumSha256: new Uint8Array(part.checksumSha256) })) }));
      const response = await client.completeAgentStoreMultipartWrites(new CompleteAgentStoreMultipartWritesRequest({ storeId: request.storeId, completions: protoCompletions }), rpcOptions(options));
      return multipartResults(response.results ?? [], "complete");
    },
    async abortWrites(request, options) {
      const protoUploads = request.uploads.map((upload) => new AgentStoreMultipartWriteAbort({ context: multipartContextToProto(upload.context) }));
      const response = await client.abortAgentStoreMultipartWrites(new AbortAgentStoreMultipartWritesRequest({ storeId: request.storeId, uploads: protoUploads }), rpcOptions(options));
      return multipartResults(response.results ?? [], "abort");
    },
    async deleteFiles(request, options) {
      const protoFiles = request.files.map((file) => new AgentStoreDeleteFileEntry({ relPath: file.relPath, baseEtag: file.baseEtag, ...(file.mutationId === undefined ? {} : { mutationId: file.mutationId }) }));
      const response = await client.deleteAgentStoreFiles(new DeleteAgentStoreFilesRequest({ storeId: request.storeId, files: protoFiles }), rpcOptions(options));
      return (response.results ?? []).map(deleteOutcome);
    },
  };
}

/** Connects the protocol adapter to the remote service transport. */
export function createBcsAgentStoreClient(transport: Transport): AgentStoreCloudClient {
  return adaptBcsAgentStoreRpcClient(createClient(BackgroundComposerService, transport) as unknown as BcsAgentStoreRpcClient);
}
