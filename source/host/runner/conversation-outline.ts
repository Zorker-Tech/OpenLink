/**
 * The outline of a conversation.
 *
 * It lists what a reader can jump to — the messages, the notices and the tool calls — while leaving out what the
 * platform added for its own use: hidden prompts, trusted automation markers and the reminder the runner injected.
 */
import {
  SLATE_HIDDEN_PROMPT_MARKER,
  SLATE_TRUSTED_AUTOMATION_PROMPT_MARKER,
} from "./slate-prompt-markers.ts";
import { PrivacyCapability } from "../../packages/redaction/classification.ts";
import { RedactedString } from "../../packages/redaction/redacted-values.ts";
import type {
  SlateHydratedAgentTurn,
  SlateHydratedConversation,
  SlateHydratedConversationTurn,
} from "../../packages/agent/conversation-transcript-state.ts";
import type { SlateConversationStep } from "../../packages/agent/conversation-step-state.ts";
import type { SlateTaskToolCall } from "../../packages/agent/task-tool-call-state.ts";

/** The tool-call name a send-message call is outlined under. */
export const SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME = "sendMessageToolCall";

/** The tool-call name an MCP call is outlined under. */
export const MCP_TOOL_CALL_OUTLINE_NAME = "mcpToolCall";

/** The most characters of a tool call's arguments the outline keeps. */
export const MAX_TOOL_ACTIVITY_ARGS_CHARS = 20_000;

/** What the outline keeps of a send-message call: its text, or an attachment. */
export type OutlineMessage =
  | { readonly type: "text"; readonly content: string }
  | { readonly type: "attachment"; readonly url: string; readonly alt?: string };

/** One thing a reader can jump to in a conversation. */
export type OutlineItem =
  | { readonly kind: "user"; readonly id: string; readonly text: string; readonly hidden?: true }
  | { readonly kind: "assistant-text"; readonly id: string; readonly text: string }
  | { readonly kind: "thinking"; readonly id: string; readonly text: string; readonly durationMs: number | undefined }
  | { readonly kind: "send-message"; readonly id: string; readonly message: OutlineMessage }
  | {
    readonly kind: "tool-call";
    readonly id: string;
    readonly name: string;
    readonly status: "pending" | "failed" | "done";
    readonly summary: string | undefined;
  };

/** Arguments that can serialize themselves, as a tool call's arguments do. */
interface JsonSerializableArgs {
  toJson(): unknown;
}

/** The value of a task tool call: what it was asked and what came back. */
interface TaskCallValue {
  readonly args?: { readonly description?: string; readonly prompt?: string };
  readonly result?: {
    readonly result: { readonly case?: string; readonly value?: unknown };
  };
}

/** One action inside a computer-use call. */
interface ComputerActionValue {
  readonly action: { readonly case?: string };
}

/** The value of a computer-use tool call: what the model asked it to do. */
interface ComputerUseCallValue {
  readonly args?: { readonly actions?: readonly ComputerActionValue[] };
}

/** The value of a send-message tool call. */
interface SendMessageCallValue {
  readonly args?: {
    readonly message?: {
      readonly case?: string;
      readonly value?: unknown;
    };
  };
}

/** One tool call of a conversation, with whatever value its case carries. */
export interface OutlineToolCall {
  readonly tool: {
    readonly case?: string;
    readonly value?: TaskCallValue | ComputerUseCallValue | SendMessageCallValue | {
      readonly args?: JsonSerializableArgs;
    };
  };
}

/** One step of an agent turn: an assistant message, a thought, or a tool call. */
export type OutlineStep = {
  readonly message:
    | { readonly case: "assistantMessage"; readonly value: { readonly text: string } }
    | { readonly case: "thinkingMessage"; readonly value: { readonly text: string; readonly durationMs: number } }
    | { readonly case: "toolCall"; readonly value: OutlineToolCall };
};

/** A conversation as the runner hands it over: its turns, of either kind. */
export interface ConversationState {
  readonly turns: readonly {
    readonly turn:
      | {
        readonly case: "agentConversationTurn";
        readonly value: {
          readonly userMessage?: { readonly text?: string; readonly messageId?: string };
          readonly steps: readonly OutlineStep[];
        };
      }
      | {
        readonly case: "shellConversationTurn";
        readonly value: { readonly shellCommand?: { readonly command?: string } };
      };
  }[];
}

/** One turn of the outline, with the text and id it was built from. */
export interface OutlineTurn {
  readonly rawUserText: string;
  readonly userMessageId: string;
  readonly items: readonly OutlineItem[];
}

/** The serialized form that means a tool call carried no arguments at all. */
const EMPTY_ACTIVITY_ARGS: ReadonlySet<string> = new Set(["{}", '""', "[]", "null"]);

/** What is appended to arguments that had to be cut. */
const TRUNCATION_SUFFIX = "\n… (truncated)";

/** What a task tool call answers when it failed. */
const FAILED_TASK_RESULT_CASE = "error";

/** The event that completes a tool call. */
const TOOL_CALL_COMPLETED_EVENT = "toolCallCompleted";

/** A text without the given marker at its front, when it has it. */
function withoutPrefix(text: string, marker: string): string {
  return text.startsWith(marker) ? text.slice(marker.length) : text;
}

/** The first of the candidates that has something after trimming. */
function firstNonEmpty(...candidates: readonly (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed != null && trimmed.length > 0) return trimmed;
  }
  return undefined;
}

/** The case of a task tool call's result. */
function taskResultCase(call: TaskCallValue): string | undefined {
  return call.result?.result.case;
}

/** The error text a failed task tool call carries, when it carries one. */
function taskErrorText(call: TaskCallValue): string | undefined {
  if (taskResultCase(call) !== FAILED_TASK_RESULT_CASE) return undefined;
  const value = call.result?.result.value as { readonly error?: unknown } | undefined;
  return typeof value?.error === "string" ? value.error : undefined;
}

/** The first characters of a text, cut without splitting a utf8 sequence in half. */
function utf8Prefix(text: string, maxChars: number): string {
  return Buffer.from(text.slice(0, maxChars), "utf8").toString("utf8");
}

/** A text with the platform's own markers taken off its front. */
export function stripHiddenMarker(text: string): string {
  return withoutPrefix(
    withoutPrefix(text, SLATE_HIDDEN_PROMPT_MARKER),
    SLATE_TRUSTED_AUTOMATION_PROMPT_MARKER,
  );
}

/** Whether a computer-use call asked for exactly one screenshot. */
function isSingleScreenshot(call: OutlineToolCall): boolean {
  if (call.tool.case !== "computerUseToolCall") return false;
  const value = call.tool.value as ComputerUseCallValue | undefined;
  const actions = value?.args?.actions;
  return actions?.length === 1 && actions[0]?.action.case === "screenshot";
}

/** The name a tool call is outlined under: its case, with the two shapes readers know named. */
export function getOutlineToolCallName(call: OutlineToolCall): string {
  if (call.tool.case === "taskToolCall") return "Task";
  if (isSingleScreenshot(call)) return "Screenshot";
  return call.tool.case ?? "Tool";
}

/** The summary of a task tool call: its error when it failed, otherwise what it was asked. */
export function getTaskSummary(call: TaskCallValue): string | undefined {
  return taskErrorText(call) ?? firstNonEmpty(call.args?.description, call.args?.prompt);
}

/** The summary a tool call is outlined with, when one is known. */
export function getOutlineToolCallSummary(call: OutlineToolCall): string | undefined {
  return call.tool.case === "taskToolCall" ? getTaskSummary(call.tool.value as TaskCallValue) : undefined;
}

/** The arguments of a tool call as JSON, for a reader who wants to see them. */
export function getToolCallActivityArgs(call: OutlineToolCall): string | undefined {
  const value = call.tool.value;
  if (value == null || !("args" in value) || value.args == null || !("toJson" in value.args)) {
    return undefined;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value.args.toJson());
  } catch {
    return undefined;
  }
  if (EMPTY_ACTIVITY_ARGS.has(serialized)) return undefined;
  if (serialized.length <= MAX_TOOL_ACTIVITY_ARGS_CHARS) return serialized;
  return `${utf8Prefix(serialized, MAX_TOOL_ACTIVITY_ARGS_CHARS)}${TRUNCATION_SUFFIX}`;
}

/** Whether a tool call is a task call that failed. */
export function isFailedTaskToolCall(call: OutlineToolCall): boolean {
  if (call.tool.case !== "taskToolCall") return false;
  return taskResultCase(call.tool.value as TaskCallValue) === FAILED_TASK_RESULT_CASE;
}

/** The status a tool call is outlined with: completed calls are done or failed, the rest are pending. */
export function getOutlineToolCallStatus(
  eventName: string,
  call: OutlineToolCall,
): "pending" | "failed" | "done" {
  if (eventName !== TOOL_CALL_COMPLETED_EVENT) return "pending";
  return isFailedTaskToolCall(call) ? "failed" : "done";
}

/** The text message a send-message value carries, when it carries one. */
function textMessageOf(value: unknown): OutlineMessage | null {
  const content = (value as { readonly content?: unknown } | undefined)?.content;
  return typeof content === "string" ? { type: "text", content } : null;
}

/** The attachment message a send-message value carries, when it carries one. */
function attachmentMessageOf(value: unknown): OutlineMessage | null {
  const attachment = value as { readonly url?: unknown; readonly alt?: unknown } | undefined;
  if (typeof attachment?.url !== "string") return null;
  return {
    type: "attachment",
    url: attachment.url,
    ...(typeof attachment.alt === "string" && attachment.alt.length > 0 ? { alt: attachment.alt } : {}),
  };
}

/** The message a send-message tool call carries, in the shape the outline keeps. */
export function sendMessageFromToolCall(call: SendMessageCallValue): OutlineMessage | null {
  const message = call.args?.message;
  if (message == null) return null;
  if (message.case === "text") return textMessageOf(message.value);
  if (message.case === "attachment") return attachmentMessageOf(message.value);
  return null;
}

/** The item an assistant message becomes, or nothing when it has no text. */
function assistantTextItem(step: OutlineStep, id: string): OutlineItem | null {
  if (step.message.case !== "assistantMessage") return null;
  const { text } = step.message.value;
  return text.length === 0 ? null : { kind: "assistant-text", id, text };
}

/** The item a thought becomes, or nothing when it has no text. */
function thinkingItem(step: OutlineStep, id: string): OutlineItem | null {
  if (step.message.case !== "thinkingMessage") return null;
  const { text, durationMs } = step.message.value;
  return text.length === 0 ? null : { kind: "thinking", id, text, durationMs: durationMs > 0 ? durationMs : undefined };
}

/** The item a tool call becomes, which is a send-message item when the call sends a message. */
function toolCallItem(call: OutlineToolCall, id: string): OutlineItem | null {
  if (call.tool.case === "sendMessageToolCall") {
    const message = sendMessageFromToolCall(call.tool.value as SendMessageCallValue);
    return message == null ? null : { kind: "send-message", id, message };
  }
  const summary = getOutlineToolCallSummary(call);
  return {
    kind: "tool-call",
    id,
    name: getOutlineToolCallName(call),
    status: getOutlineToolCallStatus(TOOL_CALL_COMPLETED_EVENT, call),
    summary,
  };
}

/** The item one step of an agent turn is outlined as, when the step leaves an item at all. */
export function stepToOutlineItem(step: OutlineStep, id: string): OutlineItem | null {
  switch (step.message.case) {
    case "assistantMessage":
      return assistantTextItem(step, id);
    case "thinkingMessage":
      return thinkingItem(step, id);
    case "toolCall":
      return toolCallItem(step.message.value, id);
    default:
      return null;
  }
}

/** The user item of a turn, or nothing when the turn's text is only whitespace. */
function userItem(rawUserText: string, turnIndex: number): OutlineItem | null {
  const hidden = rawUserText.startsWith(SLATE_HIDDEN_PROMPT_MARKER);
  const text = stripHiddenMarker(rawUserText);
  if (text.trim().length === 0) return null;
  return {
    kind: "user",
    id: `outline-user-${turnIndex}`,
    text,
    ...(hidden ? { hidden: true } : {}),
  };
}

/** The outline of an agent turn: its user item, then one item per step that leaves one. */
function agentTurnOutline(turn: Extract<ConversationState["turns"][number]["turn"], { case: "agentConversationTurn" }>["value"], turnIndex: number): OutlineTurn {
  const rawUserText = turn.userMessage?.text ?? "";
  const userMessageId = turn.userMessage?.messageId ?? "";
  const items: OutlineItem[] = [];
  const user = userItem(rawUserText, turnIndex);
  if (user != null) items.push(user);
  turn.steps.forEach((step, stepIndex) => {
    const item = stepToOutlineItem(step, `outline-${turnIndex}-${stepIndex}`);
    if (item != null) items.push(item);
  });
  return { rawUserText, userMessageId, items };
}

/** The outline of a shell turn: the command it ran, as a completed tool call. */
function shellTurnOutline(turn: Extract<ConversationState["turns"][number]["turn"], { case: "shellConversationTurn" }>["value"], turnIndex: number): OutlineTurn {
  const command = turn.shellCommand?.command ?? "";
  return {
    rawUserText: "",
    userMessageId: "",
    items: [{
      kind: "tool-call",
      id: `outline-shell-${turnIndex}`,
      name: "shellToolCall",
      status: "done",
      summary: command.length > 0 ? command : undefined,
    }],
  };
}

/** The turns of a conversation, each outlined from the turn it came from. */
export function deriveOutlineTurnsFromConversationState(conversation: ConversationState): OutlineTurn[] {
  return conversation.turns.flatMap((turn, turnIndex) => {
    if (turn.turn.case === "agentConversationTurn") return [agentTurnOutline(turn.turn.value, turnIndex)];
    if (turn.turn.case === "shellConversationTurn") return [shellTurnOutline(turn.turn.value, turnIndex)];
    return [];
  });
}

/** Everything a reader can jump to in a conversation, in order. */
export function deriveOutlineFromConversationState(conversation: ConversationState): OutlineItem[] {
  return deriveOutlineTurnsFromConversationState(conversation).flatMap((turn) => turn.items);
}

function outlineText(value: string | RedactedString | undefined): string {
  if (typeof value === "string") return value
  return value instanceof RedactedString ? value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) : ""
}

function slateStepToOutlineItem(step: SlateConversationStep, id: string): OutlineItem | null {
  switch (step.kind) {
    case "assistant-message": {
      const text = outlineText(step.text)
      return text.length === 0 ? null : { kind: "assistant-text", id, text }
    }
    case "thinking-message": {
      const text = outlineText(step.text)
      return text.length === 0
        ? null
        : { kind: "thinking", id, text, durationMs: step.durationMs > 0 ? step.durationMs : undefined }
    }
    case "tool-call":
      if (step.tool.kind === "task") return slateTaskToolCallItem(step.tool, id)
      if (step.tool.kind === "shell") return toolCallItem({ tool: { case: "shellToolCall" } }, id)
      return toolCallItem({
        tool: {
          ...(step.tool.case === undefined ? {} : { case: step.tool.case }),
          ...(step.tool.value === undefined
            ? {}
            : { value: step.tool.value as Exclude<OutlineToolCall["tool"]["value"], undefined> }),
        },
      }, id)
    case "unsupported":
      return null
  }
}

function slateTaskToolCallItem(task: SlateTaskToolCall, id: string): OutlineItem {
  const failure = task.result?.kind === "error" ? outlineText(task.result.message) : undefined
  const summary = firstNonEmpty(
    failure,
    task.args === undefined ? undefined : outlineText(task.args.description),
    task.args === undefined ? undefined : outlineText(task.args.prompt),
  )
  return {
    kind: "tool-call",
    id,
    name: "Task",
    status: task.result?.kind === "error" ? "failed" : "done",
    summary,
  }
}

function slateAgentTurnOutline(turn: SlateHydratedAgentTurn, turnIndex: number): OutlineTurn {
  const rawUserText = outlineText(turn.userMessage.text)
  const items: OutlineItem[] = []
  const user = userItem(rawUserText, turnIndex)
  if (user !== null) items.push(user)
  turn.steps.forEach((step, stepIndex) => {
    const item = slateStepToOutlineItem(step, `outline-${turnIndex}-${stepIndex}`)
    if (item !== null) items.push(item)
  })
  return { rawUserText, userMessageId: turn.userMessage.messageId, items }
}

function slateShellTurnOutline(turn: Extract<SlateHydratedConversationTurn, { readonly kind: "shell" }>, turnIndex: number): OutlineTurn {
  const command = outlineText(turn.invocation.commandText)
  return {
    rawUserText: "",
    userMessageId: "",
    items: [{
      kind: "tool-call",
      id: `outline-shell-${turnIndex}`,
      name: "shellToolCall",
      status: "done",
      summary: command.length > 0 ? command : undefined,
    }],
  }
}

/** The turns of Slate's hydrated conversation, projected to the existing session-outline contract. */
export function deriveOutlineTurnsFromSlateConversation(conversation: SlateHydratedConversation): OutlineTurn[] {
  return conversation.turns.map((turn, turnIndex) => turn.kind === "agent"
    ? slateAgentTurnOutline(turn, turnIndex)
    : slateShellTurnOutline(turn, turnIndex))
}

/** Everything a reader can jump to in a Slate-hydrated conversation, in order. */
export function deriveOutlineFromSlateConversation(conversation: SlateHydratedConversation): OutlineItem[] {
  return deriveOutlineTurnsFromSlateConversation(conversation).flatMap(turn => turn.items)
}
