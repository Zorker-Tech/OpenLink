/**
 * The Bot turn stream.
 *
 * A Bot prompt is durably accepted by Work-host before this route starts
 * streaming. The route then forwards only the frames that belong to the Bot's
 * agent: transcript appends and updates, outline progress, and the Bot turn
 * lifecycle. It never calls the Code prompt stream.
 *
 * The client may disconnect at any time. A Bot is not a request-scoped chat,
 * so a disconnect stops the projection, not the turn.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, respondError } from "./gateway-server-http.ts";
import type { GatewayServerDeps } from "./gateway-server-contracts.ts";

const IDLE_END_MS = 20 * 60_000;
const TOTAL_END_MS = 60 * 60_000;
const HEARTBEAT_MS = 15_000;
const FORWARDED_CHANNELS = new Set(["transcript", "outline", "bot-turn", "tray", "agent-upserted"]);

interface BotPromptBody {
  readonly agentId: string;
  readonly prompt: string;
  readonly clientNonce?: string;
}

function parseBody(raw: string): BotPromptBody {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Bot prompt body is not JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Bot prompt body is invalid");
  const body = value as Record<string, unknown>;
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const clientNonce = typeof body.clientNonce === "string" && body.clientNonce.length > 0 ? body.clientNonce : undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(agentId)) throw new Error("Bot prompt agentId is invalid");
  if (prompt.length === 0 || prompt.length > 100_000) throw new Error("Bot prompt is invalid");
  return { agentId, prompt, ...(clientNonce === undefined ? {} : { clientNonce }) };
}

function belongsToAgent(event: unknown, agentId: string): boolean {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return false;
  const record = event as Record<string, unknown>;
  const channel = typeof record.channel === "string" ? record.channel : "";
  if (!FORWARDED_CHANNELS.has(channel)) return false;
  const payload = record.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const payloadRecord = payload as Record<string, unknown>;
  if (payloadRecord.agentId === agentId) return true;
  if (channel === "agent-upserted") {
    const agent = payloadRecord.agent;
    return agent !== null && typeof agent === "object" && !Array.isArray(agent) && (agent as Record<string, unknown>).id === agentId;
  }
  if (channel === "tray") {
    // A tray frame carries its owner inside the tray record, not at the
    // payload root.
    const tray = payloadRecord.tray;
    return tray !== null && typeof tray === "object" && !Array.isArray(tray)
      && (tray as Record<string, unknown>).agentId === agentId;
  }
  return false;
}

function isTerminal(event: unknown): boolean {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return false;
  const record = event as Record<string, unknown>;
  if (record.channel === "bot-turn") {
    const payload = record.payload;
    return payload !== null && typeof payload === "object" && !Array.isArray(payload)
      && (payload as Record<string, unknown>).phase === "ended";
  }
  if (record.channel === "transcript") {
    const payload = record.payload;
    return payload !== null && typeof payload === "object" && !Array.isArray(payload)
      && (payload as Record<string, unknown>).type === "group-turn"
      && (payload as Record<string, unknown>).phase === "ended";
  }
  if (record.channel === "tray") {
    const payload = record.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
    const trayEvent = payload as Record<string, unknown>;
    return trayEvent.type === "pushed"
      && trayEvent.tray !== null && typeof trayEvent.tray === "object" && !Array.isArray(trayEvent.tray)
      && (trayEvent.tray as Record<string, unknown>).kind === "error";
  }
  return false;
}

export async function handleBotPromptStream(
  dependencies: GatewayServerDeps,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let body: BotPromptBody;
  try {
    body = parseBody(await readBody(request));
  } catch (error) {
    return respondError(response, 400, error instanceof Error ? error.message : "Bot prompt is invalid");
  }

  // Subscribe before accepting the prompt: the runner may start and settle
  // between the acceptance call and the first read of this stream.
  let terminal = false;
  const pending: string[] = [];
  let wake: (() => void) | null = null;
  const unsubscribe = dependencies.subscribe((event) => {
    if (!belongsToAgent(event, body.agentId)) return;
    if (isTerminal(event)) terminal = true;
    pending.push(`${JSON.stringify(event)}\n`);
    wake?.();
  });

  try {
    await dependencies.api.sendPrompt({
      agentId: body.agentId,
      prompt: body.prompt,
      ...(body.clientNonce === undefined ? {} : { clientNonce: body.clientNonce }),
    });
  } catch (error) {
    unsubscribe();
    throw error;
  }

  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders?.();

  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    heartbeat = setInterval(() => {
      if (response.destroyed || response.writableEnded) return;
      response.write("\n");
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    while (!response.destroyed && !response.writableEnded) {
      if (pending.length > 0) {
        response.write(pending.splice(0).join(""));
        lastActivityAt = Date.now();
        continue;
      }
      if (terminal) break;
      if (Date.now() - lastActivityAt >= IDLE_END_MS) break;
      if (Date.now() - startedAt >= TOTAL_END_MS) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        const timer = setTimeout(resolve, HEARTBEAT_MS);
        timer.unref?.();
      });
      wake = null;
    }
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    unsubscribe();
    if (!response.writableEnded) response.end();
  }
}
