/** The shortest interval between notices of the same kind for one agent. */
export const SLATE_OS_NOTIFICATION_THROTTLE_MS = 5_000;

/** Maximum number of UTF-16 code units carried in a notification body. */
export const MAX_NOTIFICATION_BODY_LENGTH = 140;

export interface NotificationSnapshot {
  readonly id: string;
  readonly name: string;
  readonly isRunning: boolean;
  readonly awaitingReason: string | null;
  readonly notifyEnabled: boolean;
  readonly isHiddenFromSidebar: boolean;
  readonly lastMessageId?: string | null;
  readonly lastMessagePreview: string | null;
}

export interface NotificationAgent {
  readonly id: string;
  readonly name: string;
  readonly isRunning: boolean;
  readonly awaitingUserResponse?: { readonly reason?: string | null } | null;
  readonly notifyOnUpdatesEnabled: boolean;
  readonly isHiddenFromSidebar?: boolean;
  readonly lastMessageId?: string | null;
  readonly lastMessagePreview?: string | null;
}

export type NotificationTransition = {
  readonly agentId: string;
  readonly agentName: string;
  readonly kind: "agent-needs-input" | "agent-done";
  readonly reason: string | null;
  readonly notifyEnabled: boolean;
  readonly isHiddenFromSidebar: boolean;
  readonly lastMessageId?: string | null;
  readonly lastMessagePreview: string | null;
};

export interface NotificationPolicyInput {
  readonly isHidden: boolean;
  readonly notifyEnabled: boolean;
  readonly isWindowFocused: boolean;
  readonly lastNotifiedAtMs: number | null;
  readonly nowMs: number;
  readonly throttleWindowMs: number;
}

export interface NotificationDecisionContext {
  readonly isWindowFocused: boolean;
  readonly nowMs: number;
}
