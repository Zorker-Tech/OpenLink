import { GITHUB_EVENT_KINDS, TRIGGER_ANY_SCOPE, type GithubTrigger, type SlackTrigger } from "../../shared/automations.ts";
import type { RelayWireEvent } from "./backend-relay-contracts.ts";

function stringsInOrder(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function relaySubscriptionRequestOf(slack: readonly SlackTrigger[], github: readonly GithubTrigger[]) {
  const channels = slack.map(({ channel }) => channel === TRIGGER_ANY_SCOPE ? TRIGGER_ANY_SCOPE : channel);
  const repositories = github.map(({ repo }) => repo.toLowerCase());
  const eventKinds = github.flatMap(({ events }) => events);
  return {
    slackChannels: stringsInOrder(channels),
    githubRepos: stringsInOrder(repositories),
    githubKinds: stringsInOrder(eventKinds),
  };
}

function optionalText(event: RelayWireEvent, key: string): Record<string, string> {
  const value = event[key];
  return typeof value === "string" ? { [key]: value } : {};
}

function slackChannel(event: RelayWireEvent): string | null {
  const name = typeof event.channelName === "string"
    ? event.channelName
    : typeof event.channelId === "string" ? event.channelId : "";
  if (!name) return null;
  return name === event.channelId || name.startsWith("#") ? name : `#${name}`;
}

function slackSender(event: RelayWireEvent): string {
  const userId = event.senderSlackUserId;
  return typeof userId === "string" && userId.length > 0 ? `@${userId}` : "someone";
}

function slackMessageEvent(event: RelayWireEvent, timestampMs: number): Record<string, unknown> | null {
  const channel = slackChannel(event);
  if (channel === null) return null;

  const common = {
    source: "slack",
    channel,
    sender: slackSender(event),
    text: typeof event.text === "string" ? event.text : "",
    ...optionalText(event, "ts"),
    ...optionalText(event, "threadTs"),
    timestampMs,
  };
  if (event.kind !== "reaction") return { ...common, isMention: event.isMention === true };

  const rawEmoji = typeof event.reactionEmoji === "string" ? event.reactionEmoji : "";
  if (!rawEmoji) return null;
  return {
    ...common,
    isMention: false,
    isSelf: event.isSelf === true,
    reactionEmoji: `:${rawEmoji.replaceAll(":", "")}:`,
  };
}

function githubEvent(event: RelayWireEvent, timestampMs: number): Record<string, unknown> | null {
  const repository = typeof event.repo === "string" ? event.repo : "";
  const kind = event.kind;
  if (!repository || typeof kind !== "string" || !(GITHUB_EVENT_KINDS as readonly string[]).includes(kind)) return null;

  const details = {
    ...(typeof event.prOwner === "string" && event.prOwner.length > 0 ? { prOwner: event.prOwner } : {}),
    ...(typeof event.branch === "string" && event.branch.length > 0 ? { branch: event.branch } : {}),
  };
  return {
    source: "github",
    repo: repository,
    kind,
    title: typeof event.title === "string" ? event.title : "",
    actor: typeof event.actor === "string" ? event.actor : "someone",
    ...optionalText(event, "url"),
    ...optionalText(event, "detail"),
    ...details,
    timestampMs,
  };
}

/** Project a relay record into the one event shape the listener hub accepts. */
export function mapRelayWireEvent(event: RelayWireEvent): Record<string, unknown> | null {
  const timestampMs = event.timestampMs ?? Date.now();
  return event.source === "slack"
    ? slackMessageEvent(event, timestampMs)
    : githubEvent(event, timestampMs);
}
