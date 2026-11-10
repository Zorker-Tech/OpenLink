/** Asking the user before their routines keep spending while they are away.

 * The platform watches how much of an agent's work nobody read, asks once whether the routines should keep running, and
 * applies the answer itself — including pausing every routine when no answer comes. What the user chose is written back
 * to the agent as one line to acknowledge, not as a question to ask again. */
import { formatTimestamp } from "../../shared/automation-schedule.ts";
export const SPEND_GUARD_IDLE_TTL_MS = 3 * 24 * 60 * 60_000;
export const SPEND_GUARD_MIN_UNREAD_COUNT = 15;
export const SPEND_GUARD_MIN_FIRES_SINCE_VIEWED = 20;
export const SPEND_GUARD_PAUSE_DELAY_MS = 3 * 24 * 60 * 60_000;
export const SPEND_GUARD_SNOOZE_MS = 30 * 24 * 60 * 60_000;
export const SPEND_GUARD_VALUE_PREFIX = "spend-guard:";
export const SPEND_GUARD_ANSWER_VALUES = {
  keep: `${SPEND_GUARD_VALUE_PREFIX}keep`,
  pause: `${SPEND_GUARD_VALUE_PREFIX}pause`,
  optOut: `${SPEND_GUARD_VALUE_PREFIX}never-ask`,
  resume: `${SPEND_GUARD_VALUE_PREFIX}resume`,
  stayPaused: `${SPEND_GUARD_VALUE_PREFIX}stay-paused`,
} as const;
export type SpendGuardAnswer = keyof typeof SPEND_GUARD_ANSWER_VALUES;
export function interpretSpendGuardAnswer(
  value: string,
): SpendGuardAnswer | null {
  for (const [answer, sentinelValue] of Object.entries(SPEND_GUARD_ANSWER_VALUES))
    if (value === sentinelValue) return answer as SpendGuardAnswer;
  return null;
}
export interface SpendGuardEvaluation {
  nowMs: number;
  lastViewedAtMs: number;
  unreadCount: number;
  firesSinceViewedCount: number;
  nudgedAtMs: number | null;
  snoozedUntilMs: number | null;
  optedOut: boolean;
}
export function evaluateAutomationSpendGuard(
  state: SpendGuardEvaluation,
):
  | "opted-out"
  | "user-active"
  | "snoozed"
  | "pause"
  | "awaiting-ack"
  | "nudge"
  | "below-thresholds" {
  if (state.optedOut) return "opted-out";
  if (state.nowMs - state.lastViewedAtMs < SPEND_GUARD_IDLE_TTL_MS)
    return "user-active";
  if (state.snoozedUntilMs != null && state.nowMs < state.snoozedUntilMs)
    return "snoozed";
  if (state.nudgedAtMs != null && state.nudgedAtMs > state.lastViewedAtMs)
    return state.nowMs - state.nudgedAtMs >= SPEND_GUARD_PAUSE_DELAY_MS
      ? "pause"
      : "awaiting-ack";
  if (
    state.unreadCount >= SPEND_GUARD_MIN_UNREAD_COUNT ||
    state.firesSinceViewedCount >= SPEND_GUARD_MIN_FIRES_SINCE_VIEWED
  )
    return "nudge";
  return "below-thresholds";
}
export function countAutomationRunsSince(
  schedules: readonly { runs: readonly { startedAt: number }[] }[],
  cutoffMs: number,
): number {
  let total = 0;
  for (const schedule of schedules)
    for (const execution of schedule.runs) if (execution.startedAt > cutoffMs) total++;
  return total;
}
export interface SpendGuardWidget {
  prompt: string;
  options: Array<{ label: string; value: string; style?: string }>;
}
export function buildSpendGuardNudgeWidget(): SpendGuardWidget {
  return {
    prompt: "You've been away for a bit — keep my routines running?",
    options: [
      {
        label: "Keep them running",
        value: SPEND_GUARD_ANSWER_VALUES.keep,
        style: "primary",
      },
      { label: "Pause them all", value: SPEND_GUARD_ANSWER_VALUES.pause },
      {
        label: "Keep running, don't ask again",
        value: SPEND_GUARD_ANSWER_VALUES.optOut,
      },
    ],
  };
}
export function buildSpendGuardPausedWidget(): SpendGuardWidget {
  return {
    prompt:
      "I paused all your routines while you were away to avoid wasted spend. Want me to start them back up?",
    options: [
      {
        label: "Resume routines",
        value: SPEND_GUARD_ANSWER_VALUES.resume,
        style: "primary",
      },
      {
        label: "Keep them paused",
        value: SPEND_GUARD_ANSWER_VALUES.stayPaused,
      },
    ],
  };
}
export const SPEND_GUARD_ANSWER_ACKS: Record<SpendGuardAnswer, string> = {
  keep: "keep your routines running, and not to be asked again for a month",
  resume: "start the paused routines back up",
  optOut: "keep your routines running and never be asked about this again",
  pause: "pause every one of your routines",
  stayPaused: "leave your routines paused",
};
export function renderSpendGuardAnswerAck(answer: SpendGuardAnswer): string {
  return [
    "<system_reminder>",
    `The app asked the user about the money your routines spend while they are away. They chose to ${SPEND_GUARD_ANSWER_ACKS[answer]}, and the app has ALREADY applied that itself.`,
    "Acknowledge their choice in one short line. Do NOT edit any automation.json and do NOT ask again.",
    "</system_reminder>",
  ].join("\n");
}
export function isSpendGuardCard(
  card: SpendGuardWidget,
  value: string,
): boolean {
  return (
    [
      buildSpendGuardNudgeWidget().prompt,
      buildSpendGuardPausedWidget().prompt,
    ].includes(card.prompt) &&
    card.options.some((choice) => choice.value === value)
  );
}
export function renderSpendGuardNudgeReminder(
  state: Pick<
    SpendGuardEvaluation,
    "nowMs" | "lastViewedAtMs" | "unreadCount" | "firesSinceViewedCount"
  > & { timeZone?: string },
): string {
  const absence =
      state.lastViewedAtMs > 0
        ? `hasn't opened this chat since ${formatTimestamp(state.lastViewedAtMs, state.timeZone)}`
        : "has never opened this chat",
    deadlineText = formatTimestamp(
      state.nowMs + SPEND_GUARD_PAUSE_DELAY_MS,
      state.timeZone,
    );
  return [
    "<system_reminder>",
    `The user ${absence} — ${state.unreadCount} of your messages are unread and your routines have run ${state.firesSinceViewedCount} times since then. They may be spending money on work nobody is reading.`,
    "The app has already asked them directly whether to keep your routines running, and applies their answer itself. Do NOT ask again yourself and do NOT edit any automation.json; just acknowledge their choice if it comes back as their reply.",
    `If they neither answer nor return by ${deadlineText}, the app will pause ALL of this agent's routines and tell them so.`,
    "</system_reminder>",
  ].join("\n");
}
