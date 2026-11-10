/** Render the pull-request details attached to a run. */

export interface PullRequestInvocationContext {
  readonly title: string;
  readonly description: string;
  readonly reviewComments: string;
  readonly buildFailures?: string | undefined;
}

export function renderPullRequestInvocationContext(context: PullRequestInvocationContext): string {
  const optionalSections = [
    context.description === "" ? undefined : `Description:\n${context.description}`,
    context.reviewComments === "" ? undefined : `Recent review comments:\n${context.reviewComments}`,
    context.buildFailures === undefined || context.buildFailures === ""
      ? undefined
      : `Build failures to consider:\n${context.buildFailures}`,
  ].filter((section): section is string => section !== undefined);

  const detail = optionalSections.length === 0 ? "" : `\n${optionalSections.join("\n")}`;
  return `<pull_request_context>\nPull request title: ${context.title}${detail}\n</pull_request_context>`;
}
