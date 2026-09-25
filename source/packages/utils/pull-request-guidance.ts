/**
 * Telling the agent which tool opens pull requests here.
 *
 * A team can pin the guidance the agent receives about creating pull requests; when it changes, the
 * user-info block a session was built with is stale and has to be rendered again. The comparison is
 * against the rendered block, so it notices both a changed rule and a rule that was removed.
 */

export const LOCAL_PR_CREATION_FORGE_RULE_PATH = "slate://internal/local-pr-creation-forge"
export const LOCAL_PR_CREATION_FORGE_GUIDANCE_HEADER = "Preferred pull request host:"
export const LEGACY_LOCAL_PR_CREATION_FORGE_GUIDANCE_HEADER = "Pull request forge (Creation Provider):"

export const FORGE_CLI_GLOSSARY = [
  "Slate can open new pull requests on GitHub with the `gh` CLI (`gh pr create`).",
  "Prefer `gh` over `gt`; if you use `gt`, you MUST pass `--github` for the intended host.",
].join("\n")

export function shouldRerenderUserInfoForLocalPrCreationForge(args: {
  forgeRuleContent?: string
  userInfoContent: string
}): boolean {
  if (args.forgeRuleContent === undefined || args.forgeRuleContent.length === 0) {
    return [LOCAL_PR_CREATION_FORGE_GUIDANCE_HEADER, LEGACY_LOCAL_PR_CREATION_FORGE_GUIDANCE_HEADER]
      .some(header => args.userInfoContent.includes(`<user_rule>${header}`))
  }
  return !args.userInfoContent.includes(`<user_rule>${args.forgeRuleContent}</user_rule>`)
}
