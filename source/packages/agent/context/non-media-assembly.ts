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

import type { SimulatedMsgReason as SimulatedMsgReasonValue } from "../../proto/generated/agent/v1/agent_pb.ts"
import type {
  SelectedContext,
  SelectedGitPRDiffSelection,
  SelectedPullRequest,
} from "../../proto/generated/agent/v1/selected_context_pb.ts"
import { buildGitCommitsUserContent } from "../git-commit-processing.ts"
import { buildGitDiffUncommittedUserContent, buildGitDiffUserContent } from "../git-diff-processing.ts"
import { buildGitPullRequestsUserContent } from "../git-pr-processing.ts"
import { renderConsoleLogsContext } from "./console-logs-context.ts"
import { renderSelectedCursorCommands } from "./cursor-commands-context.ts"
import { renderPrReviewContext } from "./pr-review-context.ts"
import { renderRecentAgentsContext } from "./recent-agents-context.ts"
import { renderSelectedBrowsersContext } from "./selected-browsers-context.ts"
import { renderSelectedSubagentDelegation } from "./selected-subagents-context.ts"
import { renderSimulatedMessagePrompts } from "../simulated-message-prompts.ts"
import { renderSelectedUIElementsContext } from "./ui-elements-context.ts"
import type { TaskToolModelInfo } from "../tools/task-tool-name.ts"

interface TextContent {
  readonly type: "text";
  readonly text: string;
}

export interface AppendNonMediaSelectedContextContentArgs {
  readonly userContent: TextContent[];
  readonly selectedContext: SelectedContext;
  readonly hydratedSelectedPullRequests: readonly SelectedPullRequest[];
  readonly hydratedGitPrDiffSelections: readonly SelectedGitPRDiffSelection[];
  readonly extraContextsToInclude: readonly string[];
  readonly isComposerMatterhorn: boolean;
  readonly isRawTrainingSlug: boolean;
  readonly simulatedMsgReason: SimulatedMsgReasonValue;
  readonly modelInfo?: TaskToolModelInfo | undefined;
  readonly environmentParamForSubagent: boolean;
  readonly babysitV2Prompt: boolean;
  readonly enablePrCreationForgeGuidance: boolean;
}

// Extracted from ../packages/agent/dist/context-processing.js as the exact
// post-enrichment non-media append sequence. External-link scraping,
// attachment/media output, and the parent processSelectedContext dispatcher
// remain absent by design.
export function appendNonMediaSelectedContextContent({
  userContent,
  selectedContext,
  hydratedSelectedPullRequests,
  hydratedGitPrDiffSelections,
  extraContextsToInclude,
  isComposerMatterhorn,
  isRawTrainingSlug,
  simulatedMsgReason,
  modelInfo,
  environmentParamForSubagent,
  babysitV2Prompt,
  enablePrCreationForgeGuidance,
}: AppendNonMediaSelectedContextContentArgs): void {
  if (selectedContext.cursorCommands.length > 0) {
    const commandsText = renderSelectedCursorCommands(selectedContext.cursorCommands);
    if (commandsText !== undefined) {
      userContent.push(commandsText);
    }
  }
  if (selectedContext.gitDiff) {
    userContent.push(buildGitDiffUncommittedUserContent(selectedContext.gitDiff));
  }
  if (selectedContext.gitDiffFromBranchToMain) {
    userContent.push(buildGitDiffUserContent(selectedContext.gitDiffFromBranchToMain));
  }
  if (selectedContext.gitCommits.length > 0) {
    userContent.push(buildGitCommitsUserContent(selectedContext.gitCommits));
  }
  if (hydratedSelectedPullRequests.length > 0) {
    userContent.push(buildGitPullRequestsUserContent(hydratedSelectedPullRequests));
  }
  const recentAgentsText = renderRecentAgentsContext({
    recentAgents: selectedContext.recentAgentsContext?.recentAgents ?? [],
    isComposerMatterhorn,
    isRawTrainingSlug,
  });
  if (recentAgentsText !== undefined) {
    userContent.push(recentAgentsText);
  }
  const selectedSubagentsText = renderSelectedSubagentDelegation(selectedContext.selectedSubagents);
  if (selectedSubagentsText !== undefined) {
    userContent.push(selectedSubagentsText);
  }
  const prReviewText = renderPrReviewContext(hydratedGitPrDiffSelections);
  if (prReviewText !== undefined) {
    userContent.push(prReviewText);
  }
  const consoleLogsText = renderConsoleLogsContext(selectedContext.consoleLogs);
  if (consoleLogsText !== undefined) {
    userContent.push(consoleLogsText);
  }
  const uiElementsText = renderSelectedUIElementsContext(selectedContext.uiElements);
  if (uiElementsText !== undefined) {
    userContent.push(uiElementsText);
  }
  const browsersText = renderSelectedBrowsersContext(selectedContext.selectedBrowsers);
  if (browsersText !== undefined) {
    userContent.push(browsersText);
  }
  userContent.push(...renderSimulatedMessagePrompts({
    selectedContext,
    simulatedMsgReason,
    modelInfo,
    environmentParamForSubagent,
    babysitV2Prompt,
    enablePrCreationForgeGuidance,
  }));
  for (const extraContext of extraContextsToInclude) {
    userContent.push({
      type: "text",
      text: extraContext,
    });
  }
}
