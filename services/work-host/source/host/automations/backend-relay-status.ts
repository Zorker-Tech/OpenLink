import { describeScopeIssues, type ListenerScopeIssue } from "./listener-platforms.ts";
import type { RelayStatus } from "./backend-relay-contracts.ts";

interface SlackRegistration {
  readonly status?: string;
  readonly teams?: readonly {
    readonly channels?: readonly { readonly input: string; readonly isBotMember?: boolean }[];
    readonly unresolvedChannels?: readonly string[];
  }[];
}

interface GithubRegistration {
  readonly status?: string;
  readonly repos?: readonly { readonly repo: string; readonly isSubscribed: boolean; readonly detail?: string }[];
}

export function slackStatusAfterRegistration(hasListeners: boolean, registration: SlackRegistration | undefined): RelayStatus | undefined {
  if (!hasListeners) return undefined;
  if (registration?.status === "not-linked") {
    return { state: "error", detail: "Slack isn't connected to your Slate account. Connect it to start listening." };
  }

  const issues: ListenerScopeIssue[] = [];
  for (const team of registration?.teams ?? []) {
    for (const channel of team.channels ?? []) {
      if (channel.isBotMember === false) issues.push({ scope: channel.input, kind: "bot-not-in-channel" });
    }
    for (const scope of team.unresolvedChannels ?? []) issues.push({ scope, kind: "not-found" });
  }
  return issues.length === 0
    ? { state: "listening" }
    : { state: "listening", detail: describeScopeIssues(issues), scopeIssues: issues };
}

export function githubStatusAfterRegistration(hasListeners: boolean, registration: GithubRegistration | undefined): RelayStatus | undefined {
  if (!hasListeners) return undefined;
  if (registration?.status === "not-connected") {
    return { state: "error", detail: "GitHub isn't connected to your Slate account. Connect it to start listening." };
  }

  const failedRepositories = (registration?.repos ?? []).filter(({ isSubscribed }) => !isSubscribed);
  if (failedRepositories.length === 0) return { state: "listening" };
  const allFailed = failedRepositories.length === (registration?.repos ?? []).length;
  const detail = failedRepositories.map(({ repo, detail: failureDetail }) => failureDetail ?? `Can't watch ${repo}.`).join(" ");
  return { state: allFailed ? "error" : "listening", detail };
}

export function relayRegistrationIsDegraded(slack: RelayStatus, github: RelayStatus): boolean {
  return slack.state === "error"
    || (slack.scopeIssues?.length ?? 0) > 0
    || github.state === "error"
    || github.detail != null;
}
