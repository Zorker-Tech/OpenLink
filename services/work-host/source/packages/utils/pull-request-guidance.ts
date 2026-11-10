/** Rule address and headings used to refresh pull-request guidance in the first user-info block. */

export const PULL_REQUEST_GUIDANCE_RULE_PATH = "slate://internal/local-pr-creation-forge";
export const PULL_REQUEST_GUIDANCE_HEADER = "Preferred pull request host:";
export const LEGACY_PULL_REQUEST_GUIDANCE_HEADER = "Pull request forge (Creation Provider):";

export const PULL_REQUEST_CREATION_GUIDANCE = [
  "Use the repository host configured for this workspace.",
  "Choose the target repository and branch explicitly when multiple remotes are available.",
].join("\n");

interface UserInfoPullRequestRuleState {
  readonly selectedRule?: string;
  readonly renderedUserInfo: string;
}

export function shouldRebuildUserInfoForPullRequestRule(state: UserInfoPullRequestRuleState): boolean {
  const { selectedRule, renderedUserInfo } = state;
  if (selectedRule === undefined || selectedRule.length === 0) {
    return [PULL_REQUEST_GUIDANCE_HEADER, LEGACY_PULL_REQUEST_GUIDANCE_HEADER]
      .some((heading) => renderedUserInfo.includes(`<user_rule>${heading}`));
  }
  return !renderedUserInfo.includes(`<user_rule>${selectedRule}</user_rule>`);
}
