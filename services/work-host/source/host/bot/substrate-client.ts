/**
 * The Bot execution substrate client.
 *
 * Work-host decides when a Bot runs; the shared execution layer decides where
 * its OpenSandbox lives. This client speaks only the substrate contract:
 * ensure one sandbox for a Bot key, read its desktop, release it, and answer a
 * waiting Pi extension dialog. It never calls the Code session lease, prompt
 * stream or idle policy.
 */
import type { BotRuntimeBinding } from "./bot-runtime-store.ts";

const DEFAULT_ENSURE_TIMEOUT_MS = 300_000;
const DEFAULT_DESKTOP_TIMEOUT_MS = 120_000;
const DEFAULT_RELEASE_TIMEOUT_MS = 30_000;
const SAFE_BOT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface BotSubstrateRuntimeConfiguration {
  readonly providerId: string;
  readonly modelId: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly revision: string;
}

export interface BotSubstrateEnsureInput {
  readonly botId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly runtimeConfiguration: BotSubstrateRuntimeConfiguration;
  readonly nativeSession?: { readonly header: Record<string, unknown>; readonly entries: ReadonlyArray<Record<string, unknown>> };
  readonly agent?: "pi" | "codex";
  readonly accessMode?: "restricted" | "ask" | "open";
}

export interface BotSubstratePayload {
  readonly boxKey: string;
  readonly sandboxId: string | null;
  readonly workerUrl: string | null;
  readonly workerHeaders: Readonly<Record<string, string>>;
  readonly desktopUrl: string;
  readonly vncUrl: string;
}

export interface BotSubstrateConfig {
  readonly baseUrl: string;
  readonly token: string;
}

export class BotSubstrateError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "BotSubstrateError";
  }
}

export function botSubstrateConfig(): BotSubstrateConfig | null {
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/+$/, "");
  const token = process.env.OPENLINK_SUBSTRATE_API_TOKEN;
  return baseUrl && token ? { baseUrl, token } : null;
}

export function isBotSubstrateConfigured(): boolean {
  return botSubstrateConfig() !== null;
}

/** The stable substrate key for a Bot: opaque to the execution layer, never a chat session. */
export function botBoxKey(botId: string): string {
  if (!SAFE_BOT_ID.test(botId)) throw new BotSubstrateError("Bot identity is invalid", 400, "BOT_ID_INVALID", false);
  return `bot-${botId}`;
}

function requiredConfig(): BotSubstrateConfig {
  const config = botSubstrateConfig();
  if (config === null) throw new BotSubstrateError("Bot substrate is not configured", 503, "BOT_SUBSTRATE_NOT_CONFIGURED", true);
  return config;
}

function payloadOf(value: unknown): BotSubstratePayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BotSubstrateError("Bot substrate returned an invalid payload", 502, "BOT_SUBSTRATE_INVALID", true);
  }
  const body = value as Record<string, unknown>;
  const boxKey = typeof body.boxKey === "string" ? body.boxKey : "";
  const desktopUrl = typeof body.desktopUrl === "string" ? body.desktopUrl : "";
  const vncUrl = typeof body.vncUrl === "string" ? body.vncUrl : "";
  const sandboxId = typeof body.sandboxId === "string" ? body.sandboxId : null;
  const workerUrl = typeof body.workerUrl === "string" ? body.workerUrl : null;
  const workerHeaders: Record<string, string> = {};
  if (body.workerHeaders !== undefined) {
    if (body.workerHeaders === null || typeof body.workerHeaders !== "object" || Array.isArray(body.workerHeaders)) {
      throw new BotSubstrateError("Bot substrate returned invalid worker headers", 502, "BOT_SUBSTRATE_INVALID", true);
    }
    for (const [name, candidate] of Object.entries(body.workerHeaders as Record<string, unknown>)) {
      if (typeof candidate !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\u0000]/.test(candidate)) {
        throw new BotSubstrateError("Bot substrate returned invalid worker headers", 502, "BOT_SUBSTRATE_INVALID", true);
      }
      workerHeaders[name] = candidate;
    }
  }
  if (!boxKey || !desktopUrl || !vncUrl) {
    throw new BotSubstrateError("Bot substrate returned an incomplete payload", 502, "BOT_SUBSTRATE_INVALID", true);
  }
  return { boxKey, sandboxId, workerUrl, workerHeaders, desktopUrl, vncUrl };
}

async function request(
  path: string,
  init: { method: "POST" | "DELETE"; body: unknown; timeoutMs: number },
  attempts = 2,
): Promise<unknown> {
  const config = requiredConfig();
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(init.body),
        cache: "no-store",
        signal: AbortSignal.timeout(init.timeoutMs),
      });
    } catch (error) {
      lastError = new BotSubstrateError(
        error instanceof Error ? error.message : "Bot substrate request failed",
        503,
        "BOT_SUBSTRATE_UNAVAILABLE",
        true,
      );
      if (attempt + 1 < attempts) continue;
      throw lastError;
    }
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const detail = payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { error?: unknown }).error
        : undefined;
      const code = detail !== null && typeof detail === "object" && typeof (detail as { code?: unknown }).code === "string"
        ? (detail as { code: string }).code
        : "BOT_SUBSTRATE_FAILED";
      lastError = new BotSubstrateError(
        `Bot substrate rejected ${path} (${response.status})`,
        response.status,
        code,
        response.status >= 500 || response.status === 409,
      );
      if (attempt + 1 < attempts && response.status >= 500) continue;
      throw lastError;
    }
    return payload;
  }
  throw lastError;
}

async function boxRequest(
  path: string,
  init: { method: "POST" | "DELETE"; body: unknown; timeoutMs: number },
): Promise<BotSubstratePayload> {
  return payloadOf(await request(path, init));
}

export async function ensureBotSubstrate(input: BotSubstrateEnsureInput): Promise<BotSubstratePayload> {
  const boxKey = botBoxKey(input.botId);
  return await boxRequest(`/v1/substrate/bots/${encodeURIComponent(boxKey)}/ensure`, {
    method: "POST",
    body: {
      userId: input.userId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      runtimeConfiguration: input.runtimeConfiguration,
      ...(input.nativeSession === undefined ? {} : { nativeSession: input.nativeSession }),
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      ...(input.accessMode === undefined ? {} : { accessMode: input.accessMode }),
    },
    timeoutMs: DEFAULT_ENSURE_TIMEOUT_MS,
  });
}

export async function getBotSubstrateDesktop(input: BotSubstrateEnsureInput): Promise<BotSubstratePayload> {
  const boxKey = botBoxKey(input.botId);
  return await boxRequest(`/v1/substrate/bots/${encodeURIComponent(boxKey)}/desktop`, {
    method: "POST",
    body: {
      userId: input.userId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      runtimeConfiguration: input.runtimeConfiguration,
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      ...(input.accessMode === undefined ? {} : { accessMode: input.accessMode }),
    },
    timeoutMs: DEFAULT_DESKTOP_TIMEOUT_MS,
  });
}

export async function releaseBotSubstrate(input: {
  readonly botId: string;
  readonly userId: string;
  readonly workspaceId: string;
}): Promise<void> {
  const boxKey = botBoxKey(input.botId);
  try {
    await request(`/v1/substrate/bots/${encodeURIComponent(boxKey)}`, {
      method: "DELETE",
      body: { userId: input.userId, workspaceId: input.workspaceId },
      timeoutMs: DEFAULT_RELEASE_TIMEOUT_MS,
    });
  } catch (error) {
    // Release is idempotent and best effort: an already released sandbox is a
    // successful deletion, and a temporarily unreachable substrate must not
    // make the Bot row undeletable.
    if (error instanceof BotSubstrateError && (error.status === 404 || error.status === 503)) return;
    throw error;
  }
}

/** Answer a waiting Pi extension dialog through the Bot's own worker. */
export async function respondBotWorkerExtensionUi(
  binding: BotRuntimeBinding,
  response: { readonly id: string; readonly confirmed?: boolean; readonly value?: string; readonly cancelled?: true },
): Promise<void> {
  let result: Response;
  try {
    result = await fetch(`${binding.workerUrl}/v1/extension-ui-response`, {
      method: "POST",
      headers: { ...binding.workerHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(response),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new BotSubstrateError(
      error instanceof Error ? error.message : "Bot worker is unreachable",
      503,
      "BOT_WORKER_UNAVAILABLE",
      true,
    );
  }
  await result.body?.cancel().catch(() => undefined);
  if (!result.ok) {
    throw new BotSubstrateError(
      `Bot worker rejected the extension response (${result.status})`,
      result.status,
      "BOT_EXTENSION_RESPONSE_REJECTED",
      result.status >= 500,
    );
  }
}
