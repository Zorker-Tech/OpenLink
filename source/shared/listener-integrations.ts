/** The platforms an automation can listen to, and what each one watches. */
export type ListenerPlatformName = "github" | "slack";

export interface ListenerPlatform {
  readonly platform: ListenerPlatformName;
  readonly displayName: string;
  readonly blurb: string;
}

/** One platform, described the way a surface offers it. */
function integration(platform: ListenerPlatformName, displayName: string, blurb: string): ListenerPlatform {
  return { platform, displayName, blurb };
}

export const LISTENER_PLATFORMS: readonly ListenerPlatform[] = [
  integration("github", "GitHub", "Let automations watch a repo's PRs, comments, issues, and CI."),
  integration("slack", "Slack", "Wake automations on Slack messages, mentions, and reactions."),
];

/** The description of a platform a caller asked for, or nothing when this build cannot listen to it. */
export function listenerPlatformFor(platform: string): ListenerPlatform | undefined {
  return LISTENER_PLATFORMS.find((entry) => entry.platform === platform);
}
