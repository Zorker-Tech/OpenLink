/**
 * Everything the user attached, written into the turn in the order it should be read.
 *
 * A turn can be sent with a great deal attached — a diff, commits, pull requests, a review in progress, the
 * files the user was looking at, console output, a browser, a thread — and the model reads them in the order
 * they are appended. So the order is the substance here: what the user explicitly attached comes first,
 * because it is what the turn is about, and the ambient context follows, each piece appearing only when the
 * user actually attached it, since a section saying "nothing" costs tokens and tells the model nothing.
 *
 * Two kinds of content are appended last for the same reason. The instructions for a wake-up the user did
 * not write come after the context they refer to, so the model has read the situation before being told
 * what to do about it; and any extra context a caller collected is appended after that, because it was
 * gathered for this turn rather than attached to it.
 */

import type { GitPullRequestPromptInput } from "../git-pr-processing-contracts.ts"
import { buildGitCommitsUserContent } from "../git-commit-processing.ts"
import { buildBranchChangeAttachment, buildWorktreeChangeAttachment } from "../git-diff-processing.ts"
import { buildGitPullRequestsUserContent } from "../git-pr-processing.ts"
import { renderConsoleLogsContext } from "./console-logs-context.ts"
import type { ConsoleLogPromptInput } from "./console-logs-context.ts"
import { renderAttachedCommands } from "./attached-commands-context.ts"
import { renderPrReviewContext } from "./pr-review-context.ts"
import type { PrReviewInput } from "./pr-review-context.ts"
import { renderRecentAgentsContext } from "./recent-agents-context.ts"
import type { RecentAgentPromptInput } from "./recent-agents-context.ts"
import { renderSelectedBrowsersContext } from "./selected-browsers-context.ts"
import type { BrowserTabPromptInput } from "./selected-browsers-context.ts"
import { renderSelectedSubagentDelegation } from "./selected-subagents-context.ts"
import type { SubagentNamePromptInput } from "./selected-subagents-context.ts"
import { renderSelectedUIElementsContext } from "./ui-elements-context.ts"
import type { SelectedUIElementInput } from "./ui-elements-context.ts"
import type { NonMediaSelectedContext } from "./non-media-context-contracts.ts"

interface TextContent {
  readonly type: "text";
  readonly text: string;
}

export interface AppendNonMediaSelectedContextContentArgs {
  readonly userContent: TextContent[];
  readonly selectedContext: NonMediaSelectedContext;
  readonly simulatedMessagePrompts: readonly TextContent[];
  readonly recentAgents: readonly RecentAgentPromptInput[];
  readonly selectedUIElements: readonly SelectedUIElementInput[];
  readonly selectedBrowsers: readonly BrowserTabPromptInput[];
  readonly selectedSubagents: readonly SubagentNamePromptInput[];
  readonly consoleLogs: readonly ConsoleLogPromptInput[];
  readonly pullRequestPrompts: readonly GitPullRequestPromptInput[];
  readonly prReviewSelections: readonly PrReviewInput[];
  readonly extraContextsToInclude: readonly string[];
  readonly isComposerMatterhorn: boolean;
  readonly isRawTrainingSlug: boolean;
}

// Extracted from ../packages/agent/dist/context-processing.js as the exact
// post-enrichment non-media append sequence. External-link scraping,
// attachment/media output, and the parent processSelectedContext dispatcher
// remain absent by design.
export function appendNonMediaSelectedContextContent({
  userContent,
  selectedContext,
  recentAgents,
  selectedUIElements,
  selectedBrowsers,
  selectedSubagents,
  consoleLogs,
  pullRequestPrompts,
  prReviewSelections,
  extraContextsToInclude,
  simulatedMessagePrompts,
  isComposerMatterhorn,
  isRawTrainingSlug,
}: AppendNonMediaSelectedContextContentArgs): void {
  if (selectedContext.attachedCommands.length > 0) {
    const commandsText = renderAttachedCommands(selectedContext.attachedCommands);
    if (commandsText !== undefined) {
      userContent.push(commandsText);
    }
  }
  if (selectedContext.gitDiff) {
    userContent.push(buildWorktreeChangeAttachment(selectedContext.gitDiff));
  }
  if (selectedContext.gitDiffFromBranchToMain) {
    userContent.push(buildBranchChangeAttachment(selectedContext.gitDiffFromBranchToMain));
  }
  if (selectedContext.gitCommits.length > 0) {
    userContent.push(buildGitCommitsUserContent(selectedContext.gitCommits));
  }
  if (pullRequestPrompts.length > 0) {
    userContent.push(buildGitPullRequestsUserContent(pullRequestPrompts));
  }
  const recentAgentsText = renderRecentAgentsContext({
    recentAgents,
    isComposerMatterhorn,
    isRawTrainingSlug,
  });
  if (recentAgentsText !== undefined) {
    userContent.push(recentAgentsText);
  }
  const selectedSubagentsText = renderSelectedSubagentDelegation(selectedSubagents);
  if (selectedSubagentsText !== undefined) {
    userContent.push(selectedSubagentsText);
  }
  const prReviewText = renderPrReviewContext(prReviewSelections);
  if (prReviewText !== undefined) {
    userContent.push(prReviewText);
  }
  const consoleLogsText = renderConsoleLogsContext(consoleLogs);
  if (consoleLogsText !== undefined) {
    userContent.push(consoleLogsText);
  }
  const uiElementsText = renderSelectedUIElementsContext(selectedUIElements);
  if (uiElementsText !== undefined) {
    userContent.push(uiElementsText);
  }
  const browsersText = renderSelectedBrowsersContext(selectedBrowsers);
  if (browsersText !== undefined) {
    userContent.push(browsersText);
  }
  userContent.push(...simulatedMessagePrompts);
  for (const extraContext of extraContextsToInclude) {
    userContent.push({
      type: "text",
      text: extraContext,
    });
  }
}
