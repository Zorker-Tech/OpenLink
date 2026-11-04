import {
  GITHUB_EVENT_KINDS,
  REACTION_EMOJI_PATTERN,
  TRIGGER_MAX_GROUP_LISTENERS,
  TRIGGER_MAX_REACTION_EMOJI,
  isGithubCiEventKind,
  isValidGitBranch,
  isValidGithubRepo,
  normalizeReactionEmoji,
  triggerFromList,
  type AutomationTrigger,
  type AutomationTriggerMember,
  type GithubTrigger,
  type SlackTrigger,
} from "../../shared/automations.ts";
import {
  TRIGGER_MAX_ALLOWLIST_LOGIN_LENGTH,
  TRIGGER_MAX_ALLOWLIST_LOGINS,
  TRIGGER_MAX_BRANCH_LENGTH,
  TRIGGER_MAX_CHANNEL_LENGTH,
  TRIGGER_MAX_FILTER_IDS,
  TRIGGER_MAX_ID_LENGTH,
  TRIGGER_MAX_KEYWORD_LENGTH,
  TRIGGER_MAX_REPO_LENGTH,
} from "./automation-trigger-contracts.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoundedToken(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.replace(/[\r\n]+/g, " ").trim().slice(0, maxLength);
  return normalized.length === 0 ? null : normalized;
}

function readStringIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const unique: string[] = [];
  for (const entry of raw) {
    const id = readBoundedToken(entry, TRIGGER_MAX_ID_LENGTH);
    if (id != null && !unique.includes(id)) unique.push(id);
    if (unique.length >= TRIGGER_MAX_FILTER_IDS) break;
  }
  return unique;
}

function readEmojiList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const emojis: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const emoji = normalizeReactionEmoji(entry);
    if (REACTION_EMOJI_PATTERN.test(emoji) && !emojis.includes(emoji)) emojis.push(emoji);
    if (emojis.length >= TRIGGER_MAX_REACTION_EMOJI) break;
  }
  return emojis;
}

function readSlackTrigger(value: Record<string, unknown>): SlackTrigger | null {
  const channel = readBoundedToken(value.channel, TRIGGER_MAX_CHANNEL_LENGTH);
  const match = isRecord(value.match) ? value.match : null;
  if (channel == null || match == null) return null;

  let kind: SlackTrigger["match"] | null = null;
  if (match.kind === "mention" || match.kind === "message") {
    kind = { kind: match.kind };
  } else if (match.kind === "keyword") {
    const keyword = readBoundedToken(match.keyword, TRIGGER_MAX_KEYWORD_LENGTH);
    if (keyword != null) kind = { kind: "keyword", keyword };
  } else if (match.kind === "reaction") {
    const emojis = readEmojiList(match.emoji);
    kind = {
      kind: "reaction",
      ...(emojis.length === 0 ? {} : { emoji: emojis }),
      ...(match.bySelf === true ? { bySelf: true } : {}),
    };
  }
  return kind == null ? null : { type: "slack", channel, match: kind };
}

function readAllowedLogins(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const logins: string[] = [];
  for (const entry of raw) {
    const login = readBoundedToken(entry, TRIGGER_MAX_ALLOWLIST_LOGIN_LENGTH)?.replace(/^@+/, "");
    if (login && !logins.some((existing) => existing.toLowerCase() === login.toLowerCase())) logins.push(login);
    if (logins.length >= TRIGGER_MAX_ALLOWLIST_LOGINS) break;
  }
  return logins.length === 0 ? undefined : logins;
}

function readGithubTrigger(value: Record<string, unknown>): GithubTrigger | null {
  const repo = readBoundedToken(value.repo, TRIGGER_MAX_REPO_LENGTH);
  if (repo == null || !isValidGithubRepo(repo)) return null;

  const events: string[] = [];
  for (const event of Array.isArray(value.events) ? value.events : []) {
    if (typeof event === "string" && (GITHUB_EVENT_KINDS as readonly string[]).includes(event) && !events.includes(event)) {
      events.push(event);
    }
  }

  const branch = readBoundedToken(value.ciBranch, TRIGGER_MAX_BRANCH_LENGTH);
  const ciBranch = branch != null && isValidGitBranch(branch) ? branch : undefined;
  const selectedEvents = ciBranch == null ? events.filter((event) => !isGithubCiEventKind(event)) : events;
  if (selectedEvents.length === 0) return null;

  const userAllowlist = readAllowedLogins(value.userAllowlist);
  const includesCiEvent = selectedEvents.some(isGithubCiEventKind);
  return {
    type: "github",
    repo,
    events: selectedEvents,
    ...(userAllowlist === undefined ? {} : { userAllowlist }),
    ...(includesCiEvent && ciBranch !== undefined ? { ciBranch } : {}),
  };
}

function readTriggerMember(value: unknown): AutomationTriggerMember | null {
  if (!isRecord(value)) return null;
  if (value.type === "cron") {
    const schedule = readBoundedToken(value.schedule, 120);
    return schedule == null ? null : { type: "cron", schedule };
  }
  if (value.type === "slack") return readSlackTrigger(value);
  if (value.type === "github") return readGithubTrigger(value);

  if (value.type === "microsoftTeams") {
    const tenantId = readBoundedToken(value.tenantId, TRIGGER_MAX_ID_LENGTH);
    const teamId = readBoundedToken(value.teamId, TRIGGER_MAX_ID_LENGTH) ?? "";
    const teamIds = readStringIds(value.teamIds);
    if (tenantId == null || (teamId.length === 0 && teamIds.length === 0)) return null;
    return {
      type: "microsoftTeams",
      tenantId,
      teamId,
      teamIds,
      channelIds: readStringIds(value.channelIds),
      messageContains: typeof value.messageContains === "string"
        ? value.messageContains.replace(/[\r\n]+/g, " ").trim().slice(0, TRIGGER_MAX_KEYWORD_LENGTH)
        : "",
      messageContainsIsRegex: value.messageContainsIsRegex === true,
      blockUnauthenticatedTeamsUsers: value.blockUnauthenticatedTeamsUsers === true,
    };
  }

  if (value.type === "linear" && isRecord(value.event)) {
    const caseName = value.event.case;
    const event = caseName === "issueCreated"
      ? { case: "issueCreated" as const }
      : caseName === "statusChanged"
        ? { case: "statusChanged" as const, statusIds: readStringIds(value.event.statusIds) }
        : caseName === "endOfCycle"
          ? { case: "endOfCycle" as const, cycleIds: readStringIds(value.event.cycleIds) }
          : null;
    return event == null
      ? null
      : { type: "linear", event, projectIds: readStringIds(value.projectIds), teamIds: readStringIds(value.teamIds) };
  }

  if ((value.type === "sentry" || value.type === "pagerduty") && isRecord(value.event)) {
    const cases = value.type === "sentry"
      ? ["issueCreated", "issueResolved", "issueAssigned", "issueArchived", "issueUnresolved", "issueAny"]
      : ["incidentTriggered", "incidentAcknowledged", "incidentResolved", "incidentEscalated", "incidentAny"];
    const caseName = value.event.case;
    if (typeof caseName !== "string" || !cases.includes(caseName)) return null;
    return value.type === "sentry"
      ? { type: "sentry", event: { case: caseName }, projectIds: readStringIds(value.projectIds) }
      : { type: "pagerduty", event: { case: caseName }, serviceIds: readStringIds(value.serviceIds) };
  }
  return null;
}

function readTriggerGroup(values: readonly unknown[]): AutomationTrigger | null {
  const members: AutomationTriggerMember[] = [];
  for (const value of values) {
    const member = readTriggerMember(value);
    if (member != null) members.push(member);
    if (members.length >= TRIGGER_MAX_GROUP_LISTENERS) break;
  }
  return triggerFromList(members);
}

export function parseStoredTrigger(value: unknown): AutomationTrigger | null {
  if (Array.isArray(value)) return readTriggerGroup(value);
  if (!isRecord(value)) return null;
  if (value.type === "group") return readTriggerGroup(Array.isArray(value.listeners) ? value.listeners : []);
  return readTriggerMember(value);
}

export function serializeStoredTrigger(trigger: AutomationTrigger): unknown {
  if (trigger.type === "group") return { type: "group", listeners: trigger.listeners.map(serializeMember) };
  return serializeMember(trigger);
}

function serializeMember(member: AutomationTriggerMember): unknown {
  if (member.type === "cron") return { type: "cron", schedule: member.schedule };
  if (member.type === "slack") return { type: "slack", channel: member.channel, match: member.match };
  if (member.type === "github") {
    return {
      type: "github",
      repo: member.repo,
      events: member.events,
      ...(member.userAllowlist?.length ? { userAllowlist: member.userAllowlist } : {}),
      ...(member.ciBranch ? { ciBranch: member.ciBranch } : {}),
    };
  }
  return { ...member };
}

export function triggerIdentity(trigger: AutomationTrigger): string {
  return trigger.type === "cron" ? `cron:${trigger.schedule}` : JSON.stringify(serializeStoredTrigger(trigger));
}
