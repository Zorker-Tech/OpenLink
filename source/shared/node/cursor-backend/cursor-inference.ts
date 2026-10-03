/**
 * The client for the platform's own inference backend.
 *
 * It keeps one connection to the backend's inference service, brings the caller's account and machine in with every
 * call, and answers in the platform's own message shapes — so the host asks for a turn, a labeling or a follow-up
 * without knowing how the call is framed.
 */
import type { MethodInfoUnary, ServiceType } from "@bufbuild/protobuf";
import { join } from "node:path";
import { createClient, type Client, type Interceptor, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { DashboardService } from "../../../packages/proto/generated/aiserver/v1/dashboard_connect.ts";
import { GetUserPrivacyModeRequest, type GetUserPrivacyModeResponse } from "../../../packages/proto/generated/aiserver/v1/dashboard_pb.ts";
import { AgentService } from "../../../packages/proto/generated/agent/v1/agent_service_connect.ts";
import { GetSignedUrlForAttachedMediaRequest, type GetSignedUrlForAttachedMediaResponse } from "../../../packages/proto/generated/agent/v1/agent_service_pb.ts";
import { InferenceService } from "../../../packages/proto/generated/aiserver/v1/inference_connect.ts";
import type { InferenceReason } from "../../../packages/proto/generated/aiserver/v1/inference_pb.ts";
import { createProtoSessionProvider } from "../../../packages/chat-inference-proto/client.ts";
import { imageResizingMiddleware } from "../../../packages/chat-inference/middleware/image-resizing-middleware.ts";
import { SLATE_DEFAULT_MODEL_SELECTION } from "../../agents/agent-model.ts";
import { SLATE_COMPUTER_USE_MODEL_SELECTION, type SlateAgentModelSelection } from "../../agents/slate-agent-model.ts";
import { PrivacyMode } from "../../observability/sentry-privacy-mode.ts";
import { accountCacheScope, getConfiguredBackendUrl } from "../slate-token.ts";
import { SLATE_BOX_NAMESPACE_HEADER, SLATE_CLIENT_TYPE, getBoxNamespace, getSlateClientVersion } from "../slate-client-metadata.ts";
import { createSlateRpcTracingInterceptor } from "./rpc-tracing.ts";
import { SlateSettingsStore } from "../settings/slate-settings-store.ts";
import { getSlateRootDir } from "../../../host/host-paths.ts";
import { createProviderPromptSession } from "../../../host/extensions/inference/provider-session.ts";

export const PRIVACY_MODE_CACHE_MAX_AGE_MS = 5 * 60_000;
export const PRIVACY_MODE_FALLBACK_CACHE_MAX_AGE_MS = 10_000;
export const PRIVACY_MODE_FETCH_TIMEOUT_MS = 3_000;
export const SLATE_RUN_PRIVACY_MODE_FALLBACK = PrivacyMode.NO_TRAINING;

export interface RequestedModel { readonly modelId: string; readonly maxMode?: boolean; readonly parameters?: readonly { readonly id: string; readonly value: string }[] }
export function createSlateRequestedModelFromSelection(selection: SlateAgentModelSelection): RequestedModel { return { modelId: selection.modelId, maxMode: selection.maxMode, parameters: selection.parameters.map(({ id, value }) => ({ id, value })) }; }
export function createSlateDefaultRequestedModel(): RequestedModel { return createSlateRequestedModelFromSelection(SLATE_DEFAULT_MODEL_SELECTION); }
export function createSlateSubagentRequestedModel(modelId: string): RequestedModel { return { modelId, maxMode: true, parameters: [] }; }
export function createSlateComputerUseRequestedModel(modelId: string): RequestedModel { return createSlateRequestedModelFromSelection({ ...SLATE_COMPUTER_USE_MODEL_SELECTION, modelId }); }

export function enhancedObfuscate(bytes: Uint8Array): Uint8Array {
  let lastByte = 165;
  for (let index = 0; index < bytes.length; index += 1) {
    const current = bytes[index] ?? 0;
    bytes[index] = ((current ^ lastByte) + index % 256) & 255;
    lastByte = bytes[index] ?? 0;
  }
  return bytes;
}
export function createCursorChecksum(machineId: string, nowMs = Date.now()): string {
  const unixKiloSeconds = Math.floor(nowMs / 1_000_000);
  const bytes = new Uint8Array([
    unixKiloSeconds >> 40 & 255,
    unixKiloSeconds >> 32 & 255,
    unixKiloSeconds >> 24 & 255,
    unixKiloSeconds >> 16 & 255,
    unixKiloSeconds >> 8 & 255,
    unixKiloSeconds & 255,
  ]);
  return `${Buffer.from(enhancedObfuscate(bytes)).toString("base64url")}${machineId}`;
}

export function getSlateGhostModeHeaderFromPrivacyMode(privacyMode: PrivacyMode | undefined): "true" | "false" {
  return privacyMode === PrivacyMode.USAGE_DATA_TRAINING_ALLOWED || privacyMode === PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED ? "false" : "true";
}
export interface PrivacyLookupOptions { readonly backendUrl: string; readonly accessToken: string; readonly machineId: string }
export type PrivacyModeFetcher = (options: PrivacyLookupOptions) => Promise<PrivacyMode | undefined>;
export async function fetchSlatePrivacyMode(options: PrivacyLookupOptions, client = createSlateCursorBackendClient(
  DashboardService as typeof DashboardService & {
    readonly methods: typeof DashboardService.methods & {
      readonly getUserPrivacyMode: MethodInfoUnary<GetUserPrivacyModeRequest, GetUserPrivacyModeResponse>;
    };
  },
  { getAccessToken: async () => options.accessToken, getMachineId: async () => options.machineId }
)): Promise<PrivacyMode> {
  return (await client.getUserPrivacyMode(new GetUserPrivacyModeRequest({ inferredPrivacyMode: PrivacyMode.NO_STORAGE }), { timeoutMs: PRIVACY_MODE_FETCH_TIMEOUT_MS })).privacyMode;
}
let cachedPrivacyMode: { backendUrl: string; accountScope: string; value: Promise<PrivacyMode | undefined>; expiresAt?: number } | undefined;

export async function settlePrivacyMode(fetchPrivacyMode: PrivacyModeFetcher, options: PrivacyLookupOptions, log: (message: string) => void = console.info): Promise<PrivacyMode | undefined> {
  try { return await fetchPrivacyMode(options); }
  catch (error) { const label = error instanceof Error ? error.name : typeof error; log(`[slate:privacy] privacy-mode lookup failed, using privacy-safe fallback backend=${options.backendUrl} error=${label}`); return undefined; }
}
export async function resolveCachedSlatePrivacyMode(options: PrivacyLookupOptions, fetchPrivacyMode: PrivacyModeFetcher, now = Date.now, log?: (message: string) => void): Promise<PrivacyMode | undefined> {
  const accountScope = accountCacheScope(options.accessToken);
  const cached = cachedPrivacyMode;
  if (cached?.backendUrl === options.backendUrl && cached.accountScope === accountScope && (cached.expiresAt === undefined || now() <= cached.expiresAt)) return await cached.value;
  const startedAt = now();
  const value = settlePrivacyMode(fetchPrivacyMode, options, log);
  const entry: { backendUrl: string; accountScope: string; value: Promise<PrivacyMode | undefined>; expiresAt?: number } = { backendUrl: options.backendUrl, accountScope, value };
  cachedPrivacyMode = entry;
  const privacyMode = await value;
  entry.expiresAt = startedAt + (privacyMode === undefined ? PRIVACY_MODE_FALLBACK_CACHE_MAX_AGE_MS : PRIVACY_MODE_CACHE_MAX_AGE_MS);
  return privacyMode;
}
export function clearSlatePrivacyModeCacheForTesting(): void { cachedPrivacyMode = undefined; }

export async function resolveSlatePrivacyMode(options: PrivacyLookupOptions, fetchPrivacyMode: PrivacyModeFetcher = fetchSlatePrivacyMode): Promise<PrivacyMode | undefined> { return await resolveCachedSlatePrivacyMode(options, fetchPrivacyMode); }
export async function resolveSlateRunPrivacyMode(options: { readonly getAccessToken: (options: { backendUrl: string }) => Promise<string>; readonly getMachineId: () => Promise<string> | string; readonly backendUrl?: string }, fetchPrivacyMode: PrivacyModeFetcher = fetchSlatePrivacyMode): Promise<PrivacyMode> {
  try {
    const backendUrl = options.backendUrl ?? getConfiguredBackendUrl();
    const [accessToken, machineId] = await Promise.all([options.getAccessToken({ backendUrl }), options.getMachineId()]);
    const accountScopeAtStart = accountCacheScope(accessToken);
    const privacyMode = await resolveCachedSlatePrivacyMode({ backendUrl, accessToken, machineId }, fetchPrivacyMode);
    const currentAccessToken = await options.getAccessToken({ backendUrl });
    if (accountCacheScope(currentAccessToken) !== accountScopeAtStart) return SLATE_RUN_PRIVACY_MODE_FALLBACK;
    switch (privacyMode) {
      case PrivacyMode.NO_STORAGE:
      case PrivacyMode.NO_TRAINING:
      case PrivacyMode.USAGE_DATA_TRAINING_ALLOWED:
      case PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED: return privacyMode;
      default: return SLATE_RUN_PRIVACY_MODE_FALLBACK;
    }
  } catch { return SLATE_RUN_PRIVACY_MODE_FALLBACK; }
}
export async function resolveSlateGhostModeHeader(options: PrivacyLookupOptions, fetchPrivacyMode: PrivacyModeFetcher = fetchSlatePrivacyMode): Promise<"true" | "false"> { return getSlateGhostModeHeaderFromPrivacyMode(await resolveSlatePrivacyMode(options, fetchPrivacyMode)); }
export function getSlateInferenceBackendUrl(): string { return getConfiguredBackendUrl(); }

export interface RequestLineage { readonly parentRequestId: string; readonly rootParentRequestId: string; readonly parentAgentToolCallId?: string }
function lineageHeaders(lineage?: RequestLineage): Record<string, string> {
  if (lineage === undefined) return {};
  const sanitize = (value: string) => value.replace(/[\r\n]/g, "");
  return { "x-parent-request-id": sanitize(lineage.parentRequestId), "x-root-parent-request-id": sanitize(lineage.rootParentRequestId), ...(lineage.parentAgentToolCallId === undefined ? {} : { "x-parent-agent-tool-call-id": sanitize(lineage.parentAgentToolCallId) }) };
}
export interface InferenceHeader { get(name: string): string | null; set(name: string, value: string): void; delete(name: string): void }
export interface InferenceRequest { readonly service: { readonly typeName: string }; readonly method: { readonly name: string }; readonly header: InferenceHeader; readonly stream: boolean }
export type InferenceNext<Request extends InferenceRequest, Response> = (request: Request) => Promise<Response>;
export interface SlateInferenceOptions {
  readonly getAccessToken: (options: { backendUrl: string }) => Promise<string>;
  readonly getMachineId: () => Promise<string> | string;
  readonly backendUrl: string;
  readonly authMode?: "anonymous";
  readonly lineage?: RequestLineage;
  readonly onRequestId?: (requestId: string) => void;
  readonly resolveGhostModeHeader?: (options: PrivacyLookupOptions) => Promise<"true" | "false">;
  readonly fetchPrivacyMode?: PrivacyModeFetcher;
  readonly randomUUID?: () => string;
  readonly env?: NodeJS.ProcessEnv;
}
export function createSlateInferenceInterceptor(options: SlateInferenceOptions): Interceptor {
  return (next) => async (request) => {
    const [auth, machineId] = await Promise.all(["authMode" in options ? Promise.resolve({ mode: options.authMode } as const) : options.getAccessToken({ backendUrl: options.backendUrl }).then((accessToken) => ({ mode: "required" as const, accessToken })), options.getMachineId()]);
    const privacyLookup = request.service.typeName === "aiserver.v1.DashboardService" && request.method.name === "GetUserPrivacyMode";
    const resolveGhostMode = options.resolveGhostModeHeader ?? ((lookup: PrivacyLookupOptions) => resolveSlateGhostModeHeader(lookup, options.fetchPrivacyMode ?? fetchSlatePrivacyMode));
    const ghostMode = auth.mode === "anonymous" || privacyLookup ? "true" : await resolveGhostMode({ backendUrl: options.backendUrl, accessToken: auth.accessToken, machineId });
    const pinned = request.header.get("x-request-id");
    const requestId = pinned != null && pinned !== "" ? pinned : options.randomUUID?.() ?? globalThis.crypto.randomUUID();
    if (auth.mode === "anonymous") request.header.delete("authorization"); else request.header.set("authorization", `Bearer ${auth.accessToken}`);
    request.header.set("x-cursor-checksum", createCursorChecksum(machineId));
    request.header.set("x-cursor-client-type", SLATE_CLIENT_TYPE);
    request.header.set("x-cursor-client-version", getSlateClientVersion(options.env));
    request.header.set(SLATE_BOX_NAMESPACE_HEADER, getBoxNamespace(options.env));
    request.header.set("x-ghost-mode", ghostMode);
    request.header.set("x-request-id", requestId);
    for (const [name, value] of Object.entries(lineageHeaders(options.lineage))) request.header.set(name, value);
    if ((options.env ?? process.env).CURSOR_AGENT_CLI_LOCAL_MODE === "true") request.header.set("local-cli-mode", "true");
    options.onRequestId?.(requestId);
    return await next(request);
  };
}

export function createSlateBackendTransport(options: Omit<SlateInferenceOptions, "backendUrl">): Transport {
  const backendUrl = getSlateInferenceBackendUrl();
  return createConnectTransport({ baseUrl: backendUrl, httpVersion: "1.1", interceptors: [createSlateRpcTracingInterceptor(), createSlateInferenceInterceptor({ ...options, backendUrl })] });
}
export function createSlateCursorBackendClient<Service extends ServiceType>(service: Service, options: Omit<SlateInferenceOptions, "backendUrl">): Client<Service> { return createClient(service, createSlateBackendTransport(options)); }

export function createSlateAttachedMediaUrlProvider(options: Omit<SlateInferenceOptions, "backendUrl">) {
  const client = createSlateCursorBackendClient(AgentService, options) as unknown as {
    getSignedUrlForAttachedMedia(request: GetSignedUrlForAttachedMediaRequest, options: { signal: AbortSignal }): Promise<GetSignedUrlForAttachedMediaResponse>;
  };
  return {
    async getSignedUrlForAttachedMedia(context: { signal: AbortSignal }, request: { conversationId: string; key: string; mimeType: string; contentLengthBytes?: number }) {
      const response = await client.getSignedUrlForAttachedMedia(new GetSignedUrlForAttachedMediaRequest({
        conversationId: request.conversationId,
        key: request.key,
        mimeType: request.mimeType,
        ...(request.contentLengthBytes === undefined ? {} : { contentLengthBytes: BigInt(request.contentLengthBytes) }),
      }), { signal: context.signal });
      return {
        key: response.key,
        putUrl: response.putUrl,
        getUrl: response.getUrl,
        expiresAtUnixMs: response.expiresAtUnixMs,
        refreshAfterUnixMs: response.refreshAfterUnixMs,
      };
    },
  };
}

export function createCursorInferencePromptSession(options: Omit<SlateInferenceOptions, "backendUrl"> & {
  readonly requestedModel: RequestedModel;
  readonly inferenceReason?: InferenceReason;
}) {
  const settingsPath = join(getSlateRootDir(), "settings.json");
  const routedProvider = new SlateSettingsStore(settingsPath).getInferenceProvider();
  if (routedProvider !== "slate") return createProviderPromptSession(routedProvider);
  const client = createSlateCursorBackendClient(InferenceService, options);
  return createProtoSessionProvider(client, options.requestedModel, undefined, options.inferenceReason).getSession(imageResizingMiddleware);
}
