import { randomUUID } from "node:crypto";

import type { DeadlinePolicy } from "../../../host/extensions/scheduling.ts";
import { errorLogTag } from "../../../shared/errors/summary.ts";
import { parseRetryAfterHeaderMs } from "../../../shared/retry-after.ts";
import { getSlateBackendClientHeaders } from "../backend/slate-client-metadata-adapter.ts";
import { reportExperimentsDiagnostic } from "../../../shared/node/experiments/experiments-diagnostics.ts";

export const SLATE_EXPERIMENT_CLIENT_KEY = "slate-work-host";
export const SLATE_EXPERIMENT_LOG_ENDPOINT = "https://experiments.slate.invalid/log";

export interface ExperimentBootstrapRequest {
  readonly backendUrl: string;
  readonly deadline: DeadlinePolicy;
  readonly getAccessToken: (options: { backendUrl: string }) => Promise<string>;
  readonly getMachineId: () => Promise<string>;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export interface ExperimentBootstrapResponse {
  readonly config?: string;
  readonly retryAfterMs?: number;
}

export function experimentLogUrlAllowed(url: string): boolean {
  return url.startsWith(SLATE_EXPERIMENT_LOG_ENDPOINT);
}

export function experimentNetworkOverride(
  url: string,
  request: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (experimentLogUrlAllowed(url)) return fetchImpl(url, request);
  return Promise.resolve(new Response(null, { status: 204 }));
}

export function extractExperimentUser(config: string): Record<string, unknown> {
  const parsed = JSON.parse(config) as { user?: unknown };
  const user = parsed.user;
  return typeof user === "object" && user !== null && !Array.isArray(user)
    ? user as Record<string, unknown>
    : {};
}

export function readExperimentBootstrapUserId(config: string): string | null {
  try {
    const userId = extractExperimentUser(config).userID;
    return typeof userId === "string" ? userId : null;
  } catch (error) {
    reportExperimentsDiagnostic({ kind: "bootstrap_config_unparseable", errorClass: errorLogTag(error) });
    return null;
  }
}

export function createBootstrapChecksum(machineId: string, now = Date.now()): string {
  const timeBucket = Math.floor(now / 1e6);
  const bytes = new Uint8Array([
    timeBucket >> 40 & 255,
    timeBucket >> 32 & 255,
    timeBucket >> 24 & 255,
    timeBucket >> 16 & 255,
    timeBucket >> 8 & 255,
    timeBucket & 255,
  ]);
  let previousByte = 165;
  for (let index = 0; index < bytes.length; index += 1) {
    const nextByte = bytes[index] ?? 0;
    bytes[index] = (nextByte ^ previousByte) + index % 256;
    previousByte = bytes[index] ?? 0;
  }
  return Buffer.from(bytes).toString("base64url") + machineId;
}

function includeLocalCommandLineMode(headers: Headers, env: NodeJS.ProcessEnv): void {
  if (env.CURSOR_AGENT_CLI_LOCAL_MODE === "true") headers.set("local-cli-mode", "true");
}

function requestHeaders(machineId: string, accessToken: string | undefined, env: NodeJS.ProcessEnv | undefined): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    "x-cursor-checksum": createBootstrapChecksum(machineId),
    ...getSlateBackendClientHeaders(env),
    "x-ghost-mode": "true",
    "x-request-id": randomUUID(),
  });
  if (accessToken !== undefined) headers.set("authorization", "Bearer " + accessToken);
  includeLocalCommandLineMode(headers, env ?? process.env);
  return headers;
}

function configFromResponse(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("config" in value)) return undefined;
  const config = (value as Record<string, unknown>).config;
  return typeof config === "string" ? config : undefined;
}

export async function fetchExperimentBootstrap(
  options: ExperimentBootstrapRequest,
): Promise<ExperimentBootstrapResponse> {
  const accessToken = await options.getAccessToken({ backendUrl: options.backendUrl }).catch((error: unknown) => {
    reportExperimentsDiagnostic({ kind: "bootstrap_anonymous", errorClass: errorLogTag(error) });
    return undefined;
  });
  const machineId = await options.getMachineId();
  const request = {
    method: "POST",
    headers: requestHeaders(machineId, accessToken, options.env),
    body: "{}",
  } satisfies RequestInit;

  return options.deadline.run(async (signal) => {
    const endpoint = new URL("aiserver.v1.AnalyticsService/BootstrapStatsig", options.backendUrl);
    const response = await (options.fetchImpl ?? fetch)(endpoint, { ...request, signal });
    if (!response.ok) {
      const retryAfterMs = parseRetryAfterHeaderMs(response.headers.get("retry-after"));
      return retryAfterMs === undefined ? {} : { retryAfterMs };
    }
    const config = configFromResponse(await response.json() as unknown);
    return config === undefined ? {} : { config };
  });
}
