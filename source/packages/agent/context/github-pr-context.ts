/**
 * The pull request a cloud run was started from.
 *
 * A run started from a pull request is being asked to work on it, and the agent has no way to know which
 * one: the branch is checked out but the conversation that led to it is not. So the title, the description
 * and the recent review comments are given to it, each only when there is something to give — an empty
 * description section would read as "the description is empty" rather than "there is none".
 */

export interface GithubPrInvocationContext {
  readonly title: string
  readonly description: string
  readonly comments: string
  readonly ciFailures?: string
}

export function renderGithubPrInvocationContext(pr: GithubPrInvocationContext): string {
  return `<github_pr_context>
Here is the context of the Pull Request you are working on:
PR Title: ${pr.title}${pr.description !== ""
    ? `
PR Description:
${pr.description}`
    : ""}${pr.comments !== ""
    ? `
Recent PR Comments/Reviews:
${pr.comments}`
    : ""}${pr.ciFailures !== undefined && pr.ciFailures !== ""
    ? `
Possibly Relevant CI Failures:
${pr.ciFailures}`
    : ""}
</github_pr_context>`
}
