export const MAX_ACTIVITY_DETAIL_CHARS = 80;
export const NAMED_ACTIVITY_MAX_HOLD_MS = 2_500;

export const THINKING_ACTIVITY = { kind: "thinking" } as const;
export const SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME = "SendMessage";

export const SLATE_BOX_SHELL_TOOL_NAME = "Shell";
export const SLATE_EXTERNAL_SHELL_TOOL_NAME = "ExternalShell";
export const SLATE_BOX_READ_TOOL_NAME = "Read";
export const SLATE_EXTERNAL_READ_TOOL_NAME = "ExternalRead";
export const SLATE_BOX_AWAIT_SHELL_TOOL_NAME = "AwaitShell";
export const SLATE_EXTERNAL_AWAIT_SHELL_TOOL_NAME = "ExternalAwaitShell";

export type AgentActivity = typeof THINKING_ACTIVITY | {
  kind: "tool";
  tool: string;
  detail?: string;
  target?: string;
  callId: string;
};

export type ActivityTransition =
  | { type: "keep" | "clear" }
  | { type: "set"; activity: AgentActivity };

export type ActivityUpdate =
  | { type: "thinking-delta" }
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; status: string; args?: string; summary?: string }
  | { type: "send-message" | "turn-ended" }
  | { type: string; [key: string]: unknown };

export interface NamedActivityHoldState {
  heldActivity?: AgentActivity;
  heldSinceMs: number;
}

export const INITIAL_NAMED_ACTIVITY_HOLD_STATE: NamedActivityHoldState = { heldSinceMs: 0 };
