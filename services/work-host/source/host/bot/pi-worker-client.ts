/**
 * The Pi worker wire, as the Bot runner uses it.
 *
 * The worker is the shared in-sandbox agent runtime: it owns the Pi session,
 * the model configuration and the tools. Work-host sends one prompt, reads the
 * NDJSON event stream, and cancels through the same worker. No Code session
 * lease or Code event handler is involved.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { BotRuntimeBinding } from "./bot-runtime-store.ts";
import { parseObservationBatch, type ObservationBatch } from '../inspiration/inspiration-observations.ts';

const PROMPT_CONNECT_TIMEOUT_MS = 60_000;
const CANCEL_TIMEOUT_MS = 5_000;
const TITLE_TIMEOUT_MS = 20_000;
const INSPIRATION_CONTEXT_TIMEOUT_MS = 20_000;
const INSPIRATION_COMPLETE_TIMEOUT_MS = 90_000;

export interface PiWorkerPromptInput {
  readonly message: string;
  readonly images?: ReadonlyArray<{ readonly type: "image"; readonly data: string; readonly mimeType: string }>;
  readonly deliveryGuidance?: string;
  readonly management?: boolean;
}

export class PiWorkerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PiWorkerError";
  }
}

export class PiWorkerClient {
  #lifetime: AbortController | null = null;

  constructor(private readonly binding: BotRuntimeBinding) {}

  private headers(): Record<string, string> {
    return { ...this.binding.workerHeaders, "Content-Type": "application/json" };
  }

  private async connectPrompt(request: RequestInit, groupMember: boolean): Promise<Response> {
    const workerUrl = new URL(this.binding.workerUrl);
    const forwarded = workerUrl.hostname === "127.0.0.1" && workerUrl.pathname.startsWith("/v1/sandboxes/");
    const send = () => fetch(`${this.binding.workerUrl}${groupMember ? '/v1/group/events' : '/v1/events'}`, request);
    if (!forwarded) return send();
    for (const interval of [100, 250, 500, 800]) {
      try {
        return await send();
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        // ECONNREFUSED occurs before the prompt is sent. Never replay a turn
        // whose connection had already been established.
        if (!cause || typeof cause !== "object" || !("code" in cause) || cause.code !== "ECONNREFUSED") throw error;
        await delay(interval, undefined, { signal: request.signal ?? undefined });
      }
    }
    return send();
  }

  async prompt(input: PiWorkerPromptInput, groupMember = false): Promise<Response> {
    // The connect timeout protects the handshake only. The response body is
    // the turn stream and may legitimately stay open for a long Bot turn; the
    // runner owns its idle/total deadlines and aborts this controller when it
    // decides the turn is wedged.
    const lifetime = new AbortController();
    this.#lifetime = lifetime;
    const connectTimer = setTimeout(() => lifetime.abort(), PROMPT_CONNECT_TIMEOUT_MS);
    connectTimer.unref?.();
    let response: Response;
    try {
      response = await this.connectPrompt({
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          message: input.message,
          ...(input.deliveryGuidance === undefined ? {} : { deliveryGuidance: input.deliveryGuidance }),
          ...(input.management ? { management: true } : {}),
          ...(input.images === undefined || input.images.length === 0 ? {} : { attachments: input.images }),
        }),
        cache: "no-store",
        signal: lifetime.signal,
      }, groupMember);
    } catch {
      throw new PiWorkerError(
        "Could not reach the Bot worker. Please try again.",
        503,
        true,
      );
    } finally {
      clearTimeout(connectTimer);
    }
    if (!response.ok || response.body === null) {
      const detail = await response.text().catch(() => "");
      throw new PiWorkerError(
        detail.slice(0, 2000) || `Bot worker returned ${response.status}`,
        response.status,
        response.status >= 500,
      );
    }
    return response;
  }

  async resolveManagement(id: string, result: Record<string, unknown>, groupMember: boolean): Promise<void> {
    const response = await fetch(`${this.binding.workerUrl}/v1/${groupMember ? 'group/' : ''}management/resolve`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify({ id, result }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new PiWorkerError('The worker could not receive the management result', response.status, false);
  }

  /**
   * Ask the worker's model for a short task title. This is deliberately
   * separate from the turn: a title failure must never fail or delay the work,
   * so every failure (including an old worker without `/v1/title`) is null.
   */
  async title(message: string): Promise<string | null> {
    const text = message.replace(/\s+/g, " ").trim();
    if (!text) return null;
    try {
      const response = await fetch(`${this.binding.workerUrl}/v1/title`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ message: text.slice(0, 4000) }),
        cache: "no-store",
        signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const payload = await response.json().catch(() => null) as { title?: unknown } | null;
      if (typeof payload?.title !== "string") return null;
      const title = payload.title.replace(/\s+/g, " ").trim();
      return title.length > 0 ? Array.from(title).slice(0, 80).join("") : null;
    } catch {
      return null;
    }
  }

  /** Pull the worker's bounded metadata queue without consuming it remotely. */
  async inspirationObservations(cursor: string | null): Promise<ObservationBatch | null> {
    try {
      const url = new URL(`${this.binding.workerUrl}/v1/inspiration/observations`);
      if (cursor) url.searchParams.set('cursor', cursor);
      const response = await fetch(url, {
        method: 'POST', headers: this.headers(), cache: 'no-store', signal: AbortSignal.timeout(4_000),
      });
      return response.ok ? parseObservationBatch(await response.json()) : null;
    } catch {
      return null;
    }
  }

  /** A read-only snapshot of the Bot's workspace for the inspiration engine. */
  async inspirationContext(): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetch(`${this.binding.workerUrl}/v1/inspiration/context`, {
        method: "POST",
        headers: this.headers(),
        body: "{}",
        cache: "no-store",
        signal: AbortSignal.timeout(INSPIRATION_CONTEXT_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const payload = await response.json().catch(() => null) as unknown;
      return payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  /** Run a tool-free completion independently of the Bot's active turn. */
  async inspirationComplete(input: {
    systemPrompt: string;
    prompt: string;
    maxTokens?: number;
    temperature?: number;
    latencySensitive?: boolean;
  }, signal?: AbortSignal): Promise<{ text: string; usage?: Record<string, number>; costUsd: number } | null> {
    try {
      const response = await fetch(`${this.binding.workerUrl}/v1/inspiration/complete`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          systemPrompt: input.systemPrompt,
          prompt: input.prompt,
          ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
          ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
          ...(input.latencySensitive ? { latencySensitive: true } : {}),
        }),
        cache: "no-store",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(INSPIRATION_COMPLETE_TIMEOUT_MS)]) : AbortSignal.timeout(INSPIRATION_COMPLETE_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const payload = await response.json().catch(() => null) as {
        text?: unknown;
        usage?: unknown;
        costUsd?: unknown;
      } | null;
      if (typeof payload?.text !== "string") return null;
      const usage = payload.usage !== null && typeof payload.usage === "object" && !Array.isArray(payload.usage)
        ? Object.fromEntries(Object.entries(payload.usage as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number"))
        : undefined;
      return {
        text: payload.text,
        ...(usage === undefined ? {} : { usage }),
        costUsd: typeof payload.costUsd === "number" && Number.isFinite(payload.costUsd) ? payload.costUsd : 0,
      };
    } catch {
      return null;
    }
  }

  /** Stop reading the turn stream. The worker is cancelled separately. */
  abort(): void {
    this.#lifetime?.abort();
  }

  async cancel(groupMember = false): Promise<void> {
    await fetch(`${this.binding.workerUrl}${groupMember ? '/v1/group/cancel' : '/v1/cancel'}`, {
      method: "POST",
      headers: this.headers(),
      body: "{}",
      cache: "no-store",
      signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
    }).catch(() => undefined);
  }
}

/** One JSON object per line, as the worker writes them. */
export async function* readJsonLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const parsed = parseLine(line);
          if (parsed !== null) yield parsed;
        }
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      const parsed = parseLine(tail);
      if (parsed !== null) yield parsed;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* the reader is already closed */ }
  }
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
