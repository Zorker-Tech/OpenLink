import { SimulatedMsgReason } from "../proto/generated/agent/v1/agent_pb.ts"
import type { SimulatedMsgReason as InteropSimulatedMsgReason } from "../proto/generated/agent/v1/agent_pb.ts"
import { SelectedContext } from "../proto/generated/agent/v1/selected_context_pb.ts"
import type { TaskToolModelInfo } from "../../../packages/agent/tools/task-tool-name.ts"
import type { SlateSelectedContextForProcessing } from "../../../packages/agent/context/selected-context-processing-contracts.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import { RedactedString } from "../../../packages/redaction/redacted-values.ts"
import { fromInteropSelectedImage, projectSelectedWorkspaceContext } from "./selected-context-entry-adapter.ts"
import { fromInteropSelectedVideo } from "./video-attachment-adapter.ts"
import { fromInteropSelectedDocument } from "./document-attachment-adapter.ts"
import { toSlateInvocationContext } from "./invocation-platforms-adapter.ts"
import { projectSelectedNonMediaContext } from "./selected-non-media-context-adapter.ts"
import { decodeSelectedContextSkillAttachments } from "./selected-context-skills-adapter.ts"
import { toRecentAgentPromptInputs } from "./recent-agents-adapter.ts"
import { toSelectedUIElementInputs } from "./selected-ui-elements-adapter.ts"
import { toBrowserTabPromptInputs } from "./selected-browsers-adapter.ts"
import { toSubagentNameInputs } from "./selected-subagents-adapter.ts"
import { toConsoleLogPromptInputs } from "./selected-console-logs-adapter.ts"
import { renderInteropSimulatedMessagePrompts } from "./git-action-prompt-adapter.ts"

function contextText(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (value instanceof RedactedString) return value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  return undefined
}

export interface SelectedContextProcessingProjectionOptions {
  readonly simulatedMsgReason?: InteropSimulatedMsgReason | undefined
  readonly modelInfo?: TaskToolModelInfo | undefined
  readonly environmentParamForSubagent?: boolean | undefined
  readonly babysitV2Prompt?: boolean | undefined
  readonly enablePrCreationForgeGuidance?: boolean | undefined
}

/** Maps the complete prompt-processing view once at the selected-context compatibility boundary. */
export function projectSelectedContextForProcessing(
  source: SelectedContext | undefined,
  options: SelectedContextProcessingProjectionOptions = {},
): SlateSelectedContextForProcessing {
  const selected = source ?? new SelectedContext()
  const invocationData = selected.invocationContext
  const invocation = invocationData === undefined
    ? undefined
    : invocationData.data.case === "blobId"
      ? { kind: "stored" as const, blobId: new Uint8Array(invocationData.data.value) }
      : { kind: "inline" as const, context: toSlateInvocationContext(invocationData) }

  return {
    images: selected.selectedImages.map(fromInteropSelectedImage),
    videos: selected.selectedVideos.map(fromInteropSelectedVideo),
    documents: selected.selectedDocuments.map(fromInteropSelectedDocument),
    ...(invocation === undefined ? {} : { invocation }),
    workspace: projectSelectedWorkspaceContext(selected),
    externalLinkUrls: selected.externalLinks.map(link => link.url),
    documentReferences: selected.documentations.map(document => ({
      id: document.docId,
      displayName: document.name,
    })),
    pullRequests: selected.selectedPullRequests.map(pullRequest => ({
      number: pullRequest.number,
      url: pullRequest.url,
      localReviewDirectory: pullRequest.folderPath,
      ...(pullRequest.title === undefined ? {} : { title: pullRequest.title }),
      ...(pullRequest.summaryJson === undefined ? {} : { summaryDocument: pullRequest.summaryJson }),
      ...(pullRequest.description === undefined ? {} : { description: pullRequest.description }),
      ...(pullRequest.blobId === undefined ? {} : { blobId: new Uint8Array(pullRequest.blobId) }),
    })),
    pullRequestDiffs: selected.gitPrDiffSelections.map(selection => ({
      url: selection.prUrl,
      filePath: selection.filePath,
      startLine: selection.startLine,
      endLine: selection.endLine,
      ...(selection.diffContent === undefined ? {} : { diff: selection.diffContent }),
      ...(selection.blobId === undefined ? {} : { blobId: new Uint8Array(selection.blobId) }),
    })),
    extraContextEntries: selected.extraContextEntries.map(entry => {
      const source = entry.dataOrBlobId
      switch (source.case) {
        case "data": return { kind: "inline-text", text: source.value }
        case "blobId": return { kind: "stored-text", blobId: new Uint8Array(source.value) }
        case undefined: return { kind: "empty" }
      }
    }),
    extraContextText: [...selected.extraContext],
    skillAttachments: decodeSelectedContextSkillAttachments(selected, contextText),
    nonMedia: projectSelectedNonMediaContext(selected),
    recentAgents: toRecentAgentPromptInputs(selected.recentAgentsContext?.recentAgents ?? []),
    uiElements: toSelectedUIElementInputs(selected.uiElements),
    browserTabs: toBrowserTabPromptInputs(selected.selectedBrowsers),
    selectedSubagents: toSubagentNameInputs(selected.selectedSubagents),
    consoleLogs: toConsoleLogPromptInputs(selected.consoleLogs),
    simulatedMessagePrompts: renderInteropSimulatedMessagePrompts({
      selectedContext: selected,
      simulatedMsgReason: options.simulatedMsgReason ?? SimulatedMsgReason.UNSPECIFIED,
      modelInfo: options.modelInfo,
      environmentParamForSubagent: options.environmentParamForSubagent,
      babysitV2Prompt: options.babysitV2Prompt,
      enablePrCreationForgeGuidance: options.enablePrCreationForgeGuidance,
    }),
  }
}
