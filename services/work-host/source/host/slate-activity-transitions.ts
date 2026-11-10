import {
  INITIAL_NAMED_ACTIVITY_HOLD_STATE,
  NAMED_ACTIVITY_MAX_HOLD_MS,
  SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME,
  THINKING_ACTIVITY,
  type ActivityTransition,
  type ActivityUpdate,
  type NamedActivityHoldState,
} from "./slate-activity-contracts.ts";
import { deriveToolCallActivity } from "./slate-activity-tool-projection.ts";

const WAIT_FOR_NAME = new Set(["shellToolCall", "readToolCall", "awaitToolCall"]);
const keepTransition = (): ActivityTransition => ({ type: "keep" });
const clearTransition = (): ActivityTransition => ({ type: "clear" });

function isStreamingText(update: ActivityUpdate): boolean {
  return update.type === "thinking-delta" || update.type === "text-delta";
}

function deriveToolTransition(update: Extract<ActivityUpdate, { type: "tool-call" }>): ActivityTransition {
  if (update.name === SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME || update.status !== "pending" || WAIT_FOR_NAME.has(update.name)) return keepTransition();
  return { type: "set", activity: deriveToolCallActivity(update) };
}

/** Translate one runner event to a visible activity change. */
export function deriveActivityFromUpdate(update: ActivityUpdate): ActivityTransition {
  switch (update.type) {
    case "thinking-delta":
    case "text-delta":
      return { type: "set", activity: THINKING_ACTIVITY };
    case "send-message":
    case "turn-ended":
      return clearTransition();
    case "tool-call":
      return deriveToolTransition(update as Extract<ActivityUpdate, { type: "tool-call" }>);
    default:
      return keepTransition();
  }
}

function namedActivityIsFresh(state: NamedActivityHoldState, nowMs: number, maxHoldMs: number): boolean {
  return state.heldActivity != null && nowMs - state.heldSinceMs < maxHoldMs;
}

function holdThinkingWhileNamed(
  update: ActivityUpdate,
  state: NamedActivityHoldState,
  nowMs: number,
  maxHoldMs: number,
): ActivityTransition {
  if (isStreamingText(update) && namedActivityIsFresh(state, nowMs, maxHoldMs)) return keepTransition();
  return deriveActivityFromUpdate(update);
}

function refreshNamedActivity(state: NamedActivityHoldState, nowMs: number): NamedActivityHoldState {
  return state.heldActivity == null ? state : { ...state, heldSinceMs: nowMs };
}

/** Keep a recent tool name through short model text so it does not flicker out of the conversation surface. */
export function resolveNamedActivityHold(
  update: ActivityUpdate,
  state: NamedActivityHoldState,
  nowMs: number,
  maxHoldMs = NAMED_ACTIVITY_MAX_HOLD_MS,
): { transition: ActivityTransition; state: NamedActivityHoldState } {
  const base = deriveActivityFromUpdate(update);
  if (isStreamingText(update)) {
    return { transition: holdThinkingWhileNamed(update, state, nowMs, maxHoldMs), state };
  }
  if (update.type === "tool-call") {
    if (base.type === "set") return { transition: base, state: { heldActivity: base.activity, heldSinceMs: nowMs } };
    return { transition: base, state: refreshNamedActivity(state, nowMs) };
  }
  if (base.type === "clear") return { transition: base, state: INITIAL_NAMED_ACTIVITY_HOLD_STATE };
  return { transition: base, state };
}

/** Track group-member text streaming separately so thinking does not reopen a preview mid-sentence. */
export function createGroupMemberActivityTracker(): (update: ActivityUpdate) => ActivityTransition {
  let visibleTextIsStreaming = false;
  return (update) => {
    if (update.type === "text-delta") {
    if ((update as { text: string }).text.length === 0) return keepTransition();
      visibleTextIsStreaming = true;
      return clearTransition();
    }
    if (update.type === "thinking-delta") return visibleTextIsStreaming ? keepTransition() : { type: "set", activity: THINKING_ACTIVITY };
    if (update.type === "tool-call" && (update as { status: string }).status === "pending") {
      visibleTextIsStreaming = false;
      if ((update as { name: string }).name === SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME) return clearTransition();
    }
    if (update.type === "send-message" || update.type === "turn-ended") visibleTextIsStreaming = false;
    return deriveActivityFromUpdate(update);
  };
}
