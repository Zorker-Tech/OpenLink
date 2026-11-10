/**
 * The notices a routine automation earns.
 *
 * A GitHub listener that predates account scoping can match activity from any contributor. The reminder gives the model
 * a chance to compare that event with the saved prompt, while keeping changes conservative when the expected scope is
 * not clear.
 */
import { triggerListeners } from "../../shared/automations.ts";

export const GITHUB_LISTENER_SCOPE = "github-listener-scope";
export const GITHUB_LISTENER_SCOPE_CREATED_BEFORE_MS = Date.UTC(2026, 6, 30);

export interface NoticeAutomation {
  readonly createdAt: number;
  readonly trigger: Parameters<typeof triggerListeners>[0];
  readonly raisedNotices?: readonly string[] | undefined;
}

export interface RoutineNotice {
  readonly id: string;
  readonly applies: (automation: NoticeAutomation) => boolean;
  readonly lines: readonly string[];
}

function hasUnscopedGithubListener(automation: NoticeAutomation): boolean {
  return triggerListeners(automation.trigger).some(listener =>
    listener.type === "github" && (listener.userAllowlist == null || listener.userAllowlist.length === 0)
  );
}

function predatesAccountScope(automation: NoticeAutomation): boolean {
  return automation.createdAt < GITHUB_LISTENER_SCOPE_CREATED_BEFORE_MS
}

const githubListenerScopeNotice: RoutineNotice = {
  id: GITHUB_LISTENER_SCOPE,
  applies: automation => predatesAccountScope(automation) && hasUnscopedGithubListener(automation),
  lines: [
    `NOTICE ${GITHUB_LISTENER_SCOPE} (one reminder per automation): this older repository listener has no account filter, so a matching event can come from anyone in the repository. Compare it with the saved prompt; a run that does no work can still be intentional.`,
    "If the event is clearly out of scope, narrow the listener to a confirmed GitHub account or remove event types the saved prompt does not handle. Keep CI events open to everyone. Tell the user what changed, and make no edit when the expected account or event scope is uncertain.",
  ],
};

export const SLATE_ROUTINE_NOTICES: readonly RoutineNotice[] = [githubListenerScopeNotice];
const KNOWN_NOTICE_IDS = new Set(SLATE_ROUTINE_NOTICES.map(notice => notice.id));

export function isRoutineNoticeId(value: string): boolean {
  return KNOWN_NOTICE_IDS.has(value);
}

export function routineNoticesToRaise(automation: NoticeAutomation): RoutineNotice[] {
  const alreadyShown = new Set(automation.raisedNotices ?? []);
  const pending: RoutineNotice[] = [];
  for (const notice of SLATE_ROUTINE_NOTICES) {
    if (alreadyShown.has(notice.id) || !notice.applies(automation)) continue;
    pending.push(notice);
  }
  return pending;
}

export function routineNoticeWakeLines(automation: NoticeAutomation): string[] {
  const lines: string[] = [];
  for (const notice of routineNoticesToRaise(automation)) {
    for (const line of notice.lines) lines.push(line);
  }
  return lines;
}
