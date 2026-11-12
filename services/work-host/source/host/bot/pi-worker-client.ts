/**
 * The Pi worker wire, as the Bot runner uses it.
 *
 * The worker is the shared in-sandbox agent runtime: it owns the Pi session,
 * the model configuration and the tools. Work-host sends one prompt, reads the
 * NDJSON event stream, and cancels through the same worker. No Code session
 * lease or Code event handler is involved.
 */
import type { BotRuntimeBinding } from "./bot-runtime-store.ts";

const PROMPT_CONNECT_TIMEOUT_MS = 60_000;
const CANCEL_TIMEOUT_MS = 5_000;

export interface PiWorkerPromptInput {
  readonly message: string;
  readonly images?: ReadonlyArray<{ readonly type: "image"; readonly data: string; readonly mimeType: string }>;
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
  constructor(private readonly binding: BotRuntimeBinding) {}

  private headers(): Record<string, string> {
    return { ...this.binding.workerHeaders, "Content-Type": "application/json" };
  }

  async prompt(input: PiWorkerPromptInput): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.binding.workerUrl}/v1/events`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          message: input.message,
          ...(input.images === undefined || input.images.length === 0 ? {} : { attachments: input.images }),
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(PROMPT_CONNECT_TIMEOUT_MS),
      });
    } catch (error) {
      throw new PiWorkerError(
        error instanceof Error ? error.message : "Bot worker is unreachable",
        503,
        true,
      );
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

  async cancel(): Promise<void> {
    await fetch(`${this.binding.workerUrl}/v1/cancel`, {
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
