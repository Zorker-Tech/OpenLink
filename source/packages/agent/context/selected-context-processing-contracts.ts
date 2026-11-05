import type { DocumentationIdentifier } from "./documentation-hydration.ts"
import type { SlateDocumentAttachment } from "./document-attachment-contracts.ts"
import type { SlateImageAttachment } from "./image-attachment-contracts.ts"
import type { NonMediaSelectedContext } from "./non-media-context-contracts.ts"
import type { RecentAgentPromptInput } from "./recent-agents-context.ts"
import type { BrowserTabPromptInput } from "./selected-browsers-context.ts"
import type { SubagentNamePromptInput } from "./selected-subagents-context.ts"
import type { SlateWorkspaceSelectionContext } from "./workspace-selection-contracts.ts"
import type { ConsoleLogPromptInput } from "./console-logs-context.ts"
import type { SelectedUIElementInput } from "./ui-elements-context.ts"
import type { SlateVideoAttachment } from "./video-attachment-contracts.ts"
import type { SlateInvocationContext } from "./invocation-platforms.ts"
import type { SkillAttachmentSelection } from "../skill-attachment-contracts.ts"
import type { SimulatedMessagePromptText } from "../simulated-message-prompts.ts"
import type { SlateExtraContextEntry } from "./extra-context-hydration.ts"

/** A selected invocation is either ready to render or points at stored legacy bytes to migrate at the boundary. */
export type SlateInvocationSelection =
  | { readonly kind: "inline"; readonly context: SlateInvocationContext }
  | { readonly kind: "stored"; readonly blobId: Uint8Array }

/** A selected change review may be inline or stored in the conversation blob store. */
export interface SlatePullRequestSelection {
  readonly number: number
  readonly url: string
  readonly localReviewDirectory: string
  readonly title?: string
  readonly summaryDocument?: string
  readonly description?: string
  readonly blobId?: Uint8Array
}

/** A selected line range within a reviewed change, with optional inline or stored patch content. */
export interface SlatePullRequestDiffSelection {
  readonly url: string
  readonly filePath: string
  readonly startLine: number
  readonly endLine: number
  readonly diff?: string
  readonly blobId?: Uint8Array
}

/** Product-owned input for preparing all user-selected material for one model turn. */
export interface SlateSelectedContextForProcessing {
  readonly images: readonly SlateImageAttachment[]
  readonly videos: readonly SlateVideoAttachment[]
  readonly documents: readonly SlateDocumentAttachment[]
  readonly invocation?: SlateInvocationSelection
  readonly workspace: SlateWorkspaceSelectionContext
  readonly externalLinkUrls: readonly string[]
  readonly documentReferences: readonly DocumentationIdentifier[]
  readonly pullRequests: readonly SlatePullRequestSelection[]
  readonly pullRequestDiffs: readonly SlatePullRequestDiffSelection[]
  readonly extraContextEntries: readonly SlateExtraContextEntry[]
  readonly extraContextText: readonly string[]
  readonly skillAttachments: SkillAttachmentSelection
  readonly nonMedia: NonMediaSelectedContext
  readonly recentAgents: readonly RecentAgentPromptInput[]
  readonly uiElements: readonly SelectedUIElementInput[]
  readonly browserTabs: readonly BrowserTabPromptInput[]
  readonly selectedSubagents: readonly SubagentNamePromptInput[]
  readonly consoleLogs: readonly ConsoleLogPromptInput[]
  readonly simulatedMessagePrompts: readonly SimulatedMessagePromptText[]
}

/** Empty Slate input used when a user message carries no selected context. */
export function emptySlateSelectedContextForProcessing(): SlateSelectedContextForProcessing {
  return {
    images: [],
    videos: [],
    documents: [],
    workspace: { files: [], codeSelections: [], terminals: [], terminalSelections: [], folders: [] },
    externalLinkUrls: [],
    documentReferences: [],
    pullRequests: [],
    pullRequestDiffs: [],
    extraContextEntries: [],
    extraContextText: [],
    skillAttachments: { explicitSkills: [], ruleCandidates: [] },
    nonMedia: { attachedCommands: [], gitCommits: [] },
    recentAgents: [],
    uiElements: [],
    browserTabs: [],
    selectedSubagents: [],
    consoleLogs: [],
    simulatedMessagePrompts: [],
  }
}
