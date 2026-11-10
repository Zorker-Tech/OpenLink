import {
  TRIGGER_ANY_SCOPE,
  isGithubCiEventKind,
  normalizeReactionEmoji,
  triggerEventTriggers,
  type AutomationTrigger,
  type EventTrigger,
  type GithubTrigger,
  type SlackTrigger,
} from "../../shared/automations.ts";

function splitScope(scope: string): { readonly sigil: string; readonly name: string } {
  const sigil = scope.startsWith("#") || scope.startsWith("@") ? scope[0] ?? "" : "";
  return { sigil, name: scope.slice(sigil.length).toLowerCase() };
}

export function slackScopeMatches(scope: string, actual: string): boolean {
  if (scope === TRIGGER_ANY_SCOPE) return true;
  const expected = splitScope(scope);
  const observed = splitScope(actual);
  return !(expected.sigil && observed.sigil && expected.sigil !== observed.sigil)
    && expected.name === observed.name;
}

export function slackListenerMatches(listener: SlackTrigger, event: Record<string, unknown>): boolean {
  if (typeof event.channel !== "string" || !slackScopeMatches(listener.channel, event.channel)) return false;
  const isReactionEvent = event.reactionEmoji != null;

  if (listener.match.kind === "reaction") {
    if (!isReactionEvent || (listener.match.bySelf === true && event.isSelf !== true)) return false;
    const expected = listener.match.emoji ?? [];
    return expected.length === 0
      || (typeof event.reactionEmoji === "string" && expected.includes(normalizeReactionEmoji(event.reactionEmoji)));
  }

  if (isReactionEvent) return false;
  if (listener.match.kind === "mention") return event.isMention === true;
  if (listener.match.kind === "message") return true;
  return typeof event.text === "string" && event.text.toLowerCase().includes(listener.match.keyword.toLowerCase());
}

function userIsAdmitted(allowedUsers: readonly string[], candidate: unknown, admitMissing: boolean): boolean {
  if (typeof candidate !== "string") return admitMissing;
  return allowedUsers.some((user) => user.toLowerCase() === candidate.toLowerCase());
}

export function githubListenerMatches(
  listener: GithubTrigger,
  event: Record<string, unknown>,
  options: { readonly admitMissingSubject?: boolean } = {},
): boolean {
  if (
    typeof event.repo !== "string"
    || listener.repo.toLowerCase() !== event.repo.toLowerCase()
    || typeof event.kind !== "string"
    || !listener.events.includes(event.kind)
  ) return false;

  const allowMissingSubject = options.admitMissingSubject ?? false;
  if (isGithubCiEventKind(event.kind)) {
    if (listener.ciBranch == null) return false;
    if (typeof event.branch !== "string") return allowMissingSubject;
    if (event.branch !== listener.ciBranch) return false;
  }

  const allowlist = listener.userAllowlist ?? [];
  if (allowlist.length === 0 || isGithubCiEventKind(event.kind)) return true;

  if (["pr-opened", "pr-pushed", "pr-merged", "pr-comment", "inline-review-comment"].includes(event.kind)) {
    return userIsAdmitted(allowlist, event.prOwner, allowMissingSubject);
  }
  if (["review-approved", "review-changes-requested", "review-commented", "review-thread-resolved", "review-thread-unresolved", "review-requested"].includes(event.kind)) {
    return userIsAdmitted(allowlist, event.actor, allowMissingSubject)
      && userIsAdmitted(allowlist, event.prOwner, allowMissingSubject);
  }
  return userIsAdmitted(allowlist, event.actor, allowMissingSubject);
}

function optionalFilterMatches(values: readonly string[], actual: unknown, platformMatched: boolean): boolean {
  if (values.length === 0) return true;
  return typeof actual === "string" ? values.includes(actual) : platformMatched;
}

export function listenerMatchesEvent(
  listener: EventTrigger,
  event: Record<string, unknown>,
  options: { readonly platformMatched?: boolean; readonly admitMissingSubject?: boolean } = {},
): boolean {
  const platformMatched = options.platformMatched ?? false;
  if (listener.type === "slack") return event.source === "slack" && slackListenerMatches(listener, event);
  if (listener.type === "github") return event.source === "github" && githubListenerMatches(listener, event, options);

  if (listener.type === "microsoftTeams") {
    if (event.source !== "microsoftTeams" || (listener.tenantId && listener.tenantId !== event.tenantId)) return false;
    const allowedTeams = listener.teamIds.length > 0 ? listener.teamIds : listener.teamId ? [listener.teamId] : [];
    if (!allowedTeams.includes(event.teamId as string)) return false;
    if (listener.channelIds.length > 0 && !listener.channelIds.includes(event.channelId as string)) return false;
    const hasTextFilter = listener.messageContains !== "";
    if ((event.rootMessageId !== undefined && !hasTextFilter)
      || (listener.blockUnauthenticatedTeamsUsers && !platformMatched)) return false;
    if (!hasTextFilter) return true;
    if (listener.messageContainsIsRegex) return platformMatched;
    return typeof event.text === "string" && event.text.toLowerCase().includes(listener.messageContains.toLowerCase());
  }

  if (event.source !== listener.type) return false;
  if (listener.type === "linear") {
    if (
      listener.event.case !== event.event
      || !optionalFilterMatches(listener.projectIds, event.projectId, platformMatched)
      || !optionalFilterMatches(listener.teamIds, event.teamId, platformMatched)
    ) return false;
    if (listener.event.case === "issueCreated") return true;
    if (listener.event.case === "statusChanged") {
      return optionalFilterMatches(listener.event.statusIds, event.statusId, platformMatched);
    }
    return optionalFilterMatches(listener.event.cycleIds, event.cycleId, platformMatched);
  }

  if (listener.type === "sentry") {
    return optionalFilterMatches(listener.projectIds, event.projectId, platformMatched)
      && (listener.event.case === "issueAny" || listener.event.case === event.event);
  }
  return optionalFilterMatches(listener.serviceIds, event.serviceId, platformMatched)
    && (listener.event.case === "incidentAny" || listener.event.case === event.event);
}

export function triggerMatchesEvent(
  trigger: AutomationTrigger,
  event: Record<string, unknown>,
  options?: { readonly platformMatched?: boolean; readonly admitMissingSubject?: boolean },
): boolean {
  return triggerEventTriggers(trigger).some((listener) => listenerMatchesEvent(listener, event, options));
}
