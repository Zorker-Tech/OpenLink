/**
 * A Bot turn, executed by the shared Pi worker inside the Bot's OpenSandbox.
 *
 * This is Work-host's own runner adapter. It plugs into the host's step loop,
 * so the run queue, acceptance ledger, transcript settlement and gateway
 * events stay Work-host's, while the actual turn is Pi's. The adapter never
 * calls the Code session lease or the Code event handler.
 *
 * Delivery contract: Pi's streamed text is an outline preview, not a
 * transcript entry. The turn is delivered when the adapter emits one
 * `send-message` with the final assistant text, which is what the host
 * persists and what the Bot timeline renders.
 */
import type { BotRuntimeBinding } from "./bot-runtime-store.ts";
import { PiWorkerClient, readJsonLines, type PiWorkerPromptInput } from "./pi-worker-client.ts";
import type { RunnerUpdate } from "../runner/runner-turn-attempt.ts";
import type { SlateAgentRunnerOptions } from "../runner/slate-agent-runner.ts";

type RunnerStep = NonNullable<SlateAgentRunnerOptions["runStep"]>;
type RunStepContext = Parameters<RunnerStep>[1];

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 60 * 60_000;
const ABORT_GRACE_MS = 5_000;
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export interface PiBotRunStepOptions {
  readonly agentId: string;
  readonly getBinding: () => BotRuntimeBinding | null;
  readonly emitGatewayEvent?: (event: unknown) => void;
  readonly idleTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly now?: () => number;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The text blocks of one Pi assistant message, in order. */
function assistantText(message: unknown): string {
  const record = recordOf(message);
  if (record === null || record.role !== "assistant" || !Array.isArray(record.content)) return "";
  const parts: string[] = [];
  for (const block of record.content) {
    const content = recordOf(block);
    if (content !== null && content.type === "text" && typeof content.text === "string") parts.push(content.text);
  }
  return parts.join("");
}

function usageOf(message: unknown): Record<string, number> | undefined {
  const record = recordOf(message);
  const usage = record === null ? null : recordOf(record.usage);
  if (usage === null) return undefined;
  const result: Record<string, number> = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"]) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function toolNameOf(event: Record<string, unknown>): string | undefined {
  return typeof event.toolName === "string" ? event.toolName : undefined;
}

function toolIdOf(event: Record<string, unknown>): string | undefined {
  return typeof event.toolCallId === "string" ? event.toolCallId : undefined;
}

export function createPiBotRunStep(options: PiBotRunStepOptions): RunnerStep {
  return async (step, context) => {
    if (step > 0) return { done: true };
    return await runPiBotTurn(options, context);
  };
}

async function runPiBotTurn(options: PiBotRunStepOptions, context: RunStepContext): Promise<{ done: boolean }> {
  const binding = options.getBinding();
  if (binding === null) throw new Error("BOT_RUNTIME_BINDING_MISSING");

  const now = options.now ?? Date.now;
  const client = new PiWorkerClient(binding);
  const requestId = context.requestId;
  const emit = (update: RunnerUpdate) => context.emitUpdate(update);
  const emitGateway = (payload: Record<string, unknown>) => {
    options.emitGatewayEvent?.({ channel: "bot-turn", payload: { agentId: options.agentId, requestId, ...payload } });
  };

  emitGateway({ phase: "started" });

  let finalText = "";
  let usage: Record<string, number> | undefined;
  let settled = false;
  let aborted = false;
  let failure: string | undefined;
  let assistantError: string | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  const emittedToolStates = new Set<string>();

  const emitToolCall = (id: string | undefined, name: string | undefined, status: string, summary?: string) => {
    if (id === undefined || id.length === 0) return;
    const key = `${id}:${status}`;
    if (emittedToolStates.has(key)) return;
    emittedToolStates.add(key);
    emit({
      type: "tool-call",
      id,
      ...(name === undefined ? {} : { name }),
      status,
      ...(summary === undefined ? {} : { summary }),
    });
  };

  // Ask the worker to stop, then stop reading its stream after a bounded
  // grace. A worker that ignores the cancel cannot pin this turn forever.
  const stopStream = () => {
    void client.cancel();
    const timer = setTimeout(() => client.abort(), ABORT_GRACE_MS);
    timer.unref?.();
  };

  const cancel = () => {
    aborted = true;
    stopStream();
  };

  const resetIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      failure = "BOT_TURN_IDLE_TIMEOUT";
      stopStream();
    }, options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
  };

  const onAbort = () => cancel();
  context.signal.addEventListener("abort", onAbort, { once: true });
  try {
    resetIdle();
    totalTimer = setTimeout(() => {
      failure = "BOT_TURN_TIMEOUT";
      stopStream();
    }, options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);
    totalTimer.unref?.();

    const promptInput: PiWorkerPromptInput = { message: context.prompt };
    const response = await client.prompt(promptInput);
    if (response.body === null) throw new Error("BOT_WORKER_EMPTY_STREAM");

    try {
      for await (const event of readJsonLines(response.body)) {
        resetIdle();
        const type = typeof event.type === "string" ? event.type : "";
        if (type === "message_update") {
          const assistant = recordOf(event.assistantMessageEvent);
          const updateType = assistant === null ? "" : assistant.type;
          if (updateType === "text_delta" && typeof assistant?.delta === "string") {
            emit({ type: "text-delta", text: assistant.delta });
          } else if (updateType === "thinking_delta" && typeof assistant?.delta === "string") {
            emit({ type: "thinking-delta", text: assistant.delta });
          } else if (updateType === "toolcall_end") {
            const toolCall = recordOf(assistant?.toolCall);
            emitToolCall(
              typeof toolCall?.id === "string" ? toolCall.id : undefined,
              typeof toolCall?.name === "string" ? toolCall.name : undefined,
              "completed",
            );
          }
          continue;
        }
        if (type === "tool_execution_start") {
          emitToolCall(toolIdOf(event), toolNameOf(event), "pending");
          continue;
        }
        if (type === "tool_execution_end") {
          emitToolCall(toolIdOf(event), toolNameOf(event), event.isError === true ? "failed" : "completed");
          continue;
        }
        if (type === "message_end") {
          const message = event.message;
          const text = assistantText(message);
          if (text.trim().length > 0) finalText = text;
          const messageUsage = usageOf(message);
          if (messageUsage !== undefined) usage = messageUsage;
          const record = recordOf(message);
          if (record !== null && record.role === "assistant") {
            // The last assistant message is the authority: a later successful
            // retry clears an earlier provider error, and a final error fails
            // the turn even if Pi still emits `agent_settled`.
            assistantError = typeof record.errorMessage === "string" && record.errorMessage.trim()
              ? record.errorMessage.trim().slice(0, 2000)
              : undefined;
          }
          continue;
        }
        if (type === "turn_end") {
          const turnUsage = usageOf(event.message);
          if (turnUsage !== undefined) usage = turnUsage;
          continue;
        }
        if (type === "extension_ui_request") {
          emitExtensionUiCard(event, emit, now, context.runOptions.ackToken, emitGateway);
          continue;
        }
        if (type === "auto_retry_start") {
          emit({ type: "retrying" });
          continue;
        }
        if (type === "extension_error") {
          if (typeof event.error === "string" && event.error.trim()) failure = event.error.trim().slice(0, 2000);
          if (event.terminal === true) break;
          continue;
        }
        if (type === "agent_settled") {
          settled = true;
          break;
        }
      }
    } catch (error) {
      // A stream aborted by our own idle/total deadline or by the run signal
      // is not an extra failure; the post-loop state decides the outcome.
      if (!aborted && failure === undefined) throw error;
    }
  } catch (error) {
    if (!aborted && failure === undefined) {
      emitGateway({
        phase: "ended",
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 2000) : "BOT_WORKER_FAILED",
      });
    }
    throw error;
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    context.signal.removeEventListener("abort", onAbort);
  }

  if (aborted && failure === undefined) {
    emitGateway({ phase: "ended", aborted: true });
    return { done: true };
  }
  if (!settled || assistantError !== undefined) {
    const error = assistantError ?? failure ?? "BOT_WORKER_STREAM_ENDED";
    emitGateway({ phase: "ended", ok: false, error });
    throw new Error(error);
  }

  if (finalText.trim().length > 0) {
    emit({
      type: "send-message",
      message: { type: "text", content: finalText },
      timestampMs: now(),
      ...(typeof context.runOptions.ackToken === "string" ? { ackToken: context.runOptions.ackToken } : {}),
    });
  } else {
    // A tool-only turn still needs a durable completion marker. It is an
    // activity card, not an invented assistant reply.
    emit({
      type: "send-message",
      message: { type: "bot-activity", activity: { label: "Finished", status: "done", tool: "status" } },
      timestampMs: now(),
      ...(typeof context.runOptions.ackToken === "string" ? { ackToken: context.runOptions.ackToken } : {}),
    });
  }
  if (usage !== undefined) emit({ type: "turn-ended", usage });
  emitGateway({ phase: "ended", ok: true });
  return { done: true };
}

/**
 * A Pi dialog is a question the user must answer. It becomes a widget entry in
 * the transcript so it survives a reload, and the same id is carried on the
 * `bot-turn` channel so the Bot surface can open its answer dock. The answer
 * goes back to the waiting worker through the Bot gateway, not through a new
 * prompt.
 */
function emitExtensionUiCard(
  event: Record<string, unknown>,
  emit: (update: RunnerUpdate) => void,
  now: () => number,
  ackToken: unknown,
  emitGateway: (payload: Record<string, unknown>) => void,
): void {
  const method = typeof event.method === "string" ? event.method : "";
  if (method === "notify") {
    // A user-facing notice is durable: it becomes an activity card in the
    // Bot timeline, not a transient status line.
    const label = typeof event.message === "string" ? event.message.trim().slice(0, 2000) : "";
    if (label.length > 0) {
      emit({
        type: "send-message",
        message: { type: "bot-activity", activity: { label, status: "done", tool: "notice" } },
        timestampMs: now(),
        ...(typeof ackToken === "string" ? { ackToken } : {}),
      });
    }
    return;
  }
  if (method === "setStatus") {
    // A status line is live progress, not history. It drives the pending beat
    // and is never written to the transcript.
    const label = typeof event.statusText === "string" ? event.statusText.trim().slice(0, 200) : "";
    if (label.length > 0) emitGateway({ phase: "status", label });
    return;
  }
  const id = typeof event.id === "string" ? event.id : "";
  if (!DIALOG_METHODS.has(method) || id.length === 0) return;
  const title = typeof event.title === "string" ? event.title : undefined;
  const prompt = typeof event.message === "string" ? event.message : undefined;
  const options = Array.isArray(event.options)
    ? event.options.filter((option): option is string => typeof option === "string").slice(0, 64)
    : undefined;
  const placeholder = typeof event.placeholder === "string" ? event.placeholder : undefined;
  emit({
    type: "send-message",
    message: {
      type: "widget",
      widget: {
        kind: "bot-question",
        id,
        method,
        ...(title === undefined ? {} : { title }),
        ...(prompt === undefined ? {} : { prompt }),
        ...(options === undefined || options.length === 0 ? {} : { options }),
        ...(placeholder === undefined ? {} : { placeholder }),
      },
    },
    timestampMs: now(),
    ...(typeof ackToken === "string" ? { ackToken } : {}),
  });
  emitGateway({ phase: "awaiting-input", extensionUiId: id, method });
}
