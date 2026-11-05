import { RedactedBytes, RedactedString } from "../../redaction/redacted-values.ts"
import type { SlateTaskAttachmentSelection } from "../tools/task-attachment-contracts.ts"

/** Values carried by a selected-context snapshot before prompt policy decides whether to read them. */
export type SlateContextText = string | RedactedString
export type SlateContextBytes = Uint8Array | RedactedBytes

export type SlateSelectedImageContent =
  | { readonly kind: "inline"; readonly bytes: SlateContextBytes }
  | { readonly kind: "stored"; readonly blobId: SlateContextBytes }
  | { readonly kind: "stored-with-inline"; readonly blobId: SlateContextBytes; readonly bytes: SlateContextBytes }
  | { readonly kind: "upload"; readonly uploadId: SlateContextText }

export interface SlateSelectedImageState {
  readonly id: string
  readonly path: SlateContextText
  readonly mediaType: string
  readonly dimensions?: { readonly width: number; readonly height: number }
  readonly content?: SlateSelectedImageContent
}

export type SlateSelectedVideoContent =
  | { readonly kind: "inline"; readonly bytes: SlateContextBytes }
  | { readonly kind: "stored"; readonly blobId: SlateContextBytes }
  | { readonly kind: "stored-with-inline"; readonly blobId: SlateContextBytes; readonly bytes: SlateContextBytes }
  | {
      readonly kind: "signed-link"
      readonly url: SlateContextText
      readonly key: string
      readonly expiresAtUnixMs: bigint
      readonly refreshAfterUnixMs: bigint
      readonly conversationId: string
    }
  | { readonly kind: "empty" }

export interface SlateSelectedVideoState {
  readonly id: string
  readonly path: SlateContextText
  readonly displayName: SlateContextText
  readonly mediaType: string
  readonly frameRate?: number
  readonly writeToWorkspace: boolean
  readonly content: SlateSelectedVideoContent
}

export type SlateSelectedDocumentContent =
  | { readonly kind: "inline"; readonly bytes: SlateContextBytes }
  | { readonly kind: "stored"; readonly blobId: SlateContextBytes }
  | { readonly kind: "stored-with-inline"; readonly blobId: SlateContextBytes; readonly bytes: SlateContextBytes }
  | { readonly kind: "upload"; readonly uploadId: SlateContextText }
  | { readonly kind: "empty" }

export interface SlateSelectedDocumentState {
  readonly id: string
  readonly displayName: SlateContextText
  readonly mediaType: string
  readonly path: SlateContextText
  readonly content: SlateSelectedDocumentContent
}

export interface SlateInvocationChannel {
  readonly workspaceName?: SlateContextText
  readonly workspaceDescription?: SlateContextText
  readonly name?: SlateContextText
  readonly description?: SlateContextText
  readonly purpose?: SlateContextText
  readonly topic?: SlateContextText
  readonly teamName?: SlateContextText
  readonly teamDescription?: SlateContextText
}

export interface SlateInvocationSender {
  readonly name?: SlateContextText
  readonly id?: SlateContextText
  readonly kind?: SlateContextText
}

export interface SlateInvocationConversation {
  readonly platform: "slack" | "microsoft-teams"
  readonly body: SlateContextText
  readonly channel?: SlateInvocationChannel
  readonly sender?: SlateInvocationSender
  readonly directlyAddressed?: boolean
}

export interface SlateInvocationEditorFile {
  readonly path: SlateContextText
  readonly relativePath?: SlateContextText
  readonly cursor?: { readonly line: number; readonly text: SlateContextText }
  readonly totalLines: number
  readonly activeCommand?: SlateContextText
}

export interface SlateInvocationViewedChange {
  readonly number: number
  readonly url: SlateContextText
  readonly title?: SlateContextText
  readonly localDirectory?: SlateContextText
  readonly summaryDocument?: SlateContextText
  readonly description?: SlateContextText
}

export interface SlateInvocationEditorState {
  readonly visibleFiles: readonly SlateInvocationEditorFile[]
  readonly recentlyViewedFiles: readonly SlateInvocationEditorFile[]
  readonly viewedChanges: readonly SlateInvocationViewedChange[]
}

export type SlateInvocationSelectionState =
  | { readonly kind: "conversation"; readonly context: SlateInvocationConversation }
  | {
      readonly kind: "change-review"
      readonly title: SlateContextText
      readonly description: SlateContextText
      readonly comments: SlateContextText
      readonly buildFailures?: SlateContextText
    }
  | { readonly kind: "editor"; readonly state: SlateInvocationEditorState }
  | { readonly kind: "stored"; readonly blobId: SlateContextBytes }
  | { readonly kind: "unsupported" }

export interface SlateSelectedWorkspaceFile {
  readonly path: SlateContextText
  readonly relativePath?: SlateContextText
  readonly content: SlateContextText
}

export interface SlateSelectedPosition {
  readonly line: number
  readonly column: number
}

export interface SlateSelectedRange {
  readonly start?: SlateSelectedPosition
  readonly end?: SlateSelectedPosition
}

export interface SlateSelectedCodeRange extends SlateSelectedWorkspaceFile {
  readonly range?: SlateSelectedRange
}

export interface SlateSelectedTerminalOutput {
  readonly content: SlateContextText
  readonly title?: SlateContextText
  readonly path?: SlateContextText
}

export interface SlateSelectedTerminalRange extends SlateSelectedTerminalOutput {
  readonly range?: SlateSelectedRange
}

export interface SlateSelectedFolderState {
  readonly path: SlateContextText
  readonly relativePath?: SlateContextText
  readonly tree?: SlateSelectedDirectoryNode
}

export interface SlateSelectedDirectoryFile {
  readonly name: SlateContextText
  readonly terminalMetadata?: {
    readonly cwd?: SlateContextText
    readonly lastModifiedMs?: bigint
    readonly lastCommands?: readonly {
      readonly command: SlateContextText
      readonly exitCode?: number
      readonly timestampMs?: bigint
      readonly durationMs?: bigint
    }[]
    readonly currentCommand?: {
      readonly command: SlateContextText
      readonly exitCode?: number
      readonly timestampMs?: bigint
      readonly durationMs?: bigint
    }
  }
}

export interface SlateSelectedDirectoryNode {
  readonly path: SlateContextText
  readonly processed: boolean
  readonly files: readonly SlateSelectedDirectoryFile[]
  readonly directories: readonly SlateSelectedDirectoryNode[]
  readonly fileCount: number
  readonly extensionCounts: Readonly<Record<string, number>>
}

export interface SlateExternalResourceSelection {
  readonly id: string
  readonly url: SlateContextText
  readonly pdfText?: SlateContextText
  readonly isPdf?: boolean
  readonly displayName?: SlateContextText
  readonly blobId?: SlateContextBytes
}

export type SlateWorkspaceRuleType =
  | { readonly kind: "global" }
  | { readonly kind: "file-patterns"; readonly patterns: readonly string[] }
  | { readonly kind: "suggested"; readonly description: SlateContextText }
  | { readonly kind: "manual" }
  | { readonly kind: "unknown"; readonly wireCase: string }

export type SlateWorkspaceRuleSource = "unspecified" | "team" | "user" | `unknown-${number}`

export interface SlateWorkspaceRule {
  readonly path: SlateContextText
  readonly content: SlateContextText
  readonly type?: SlateWorkspaceRuleType
  readonly source: SlateWorkspaceRuleSource
  readonly remoteOrigin?: SlateContextText
  readonly parseError?: SlateContextText
  readonly environments: readonly string[]
  readonly disabledEnvironments: readonly string[]
  readonly pluginName?: SlateContextText
  readonly marketplaceName?: SlateContextText
  readonly pluginId?: SlateContextText
  readonly marketplaceId?: SlateContextText
  readonly scopedTo: readonly string[]
  readonly frontmatter: SlateContextText
  readonly required?: boolean
}

export interface SlateSelectedRuleRow {
  readonly rule?: SlateWorkspaceRule
}

export interface SlatePluginCapabilitySelection {
  readonly pluginId: string
  readonly capability: "unspecified" | "command" | "skill" | "subagent" | `unknown-${number}`
  readonly sourcePath: SlateContextText
  readonly snapshotToken: SlateContextText
  readonly resolvedCommit?: string
}

export interface SlateSelectedCommand {
  readonly name: string
  readonly content: SlateContextText
  readonly sourcePath?: SlateContextText
  readonly displayName?: SlateContextText
  readonly capability?: SlatePluginCapabilitySelection
}

export interface SlateSelectedDocumentationReference {
  readonly id: SlateContextText
  readonly displayName: SlateContextText
}

export interface SlateSelectedUIElement {
  readonly element: SlateContextText
  readonly xpath: SlateContextText
  readonly textContent: SlateContextText
  readonly additionalContext: SlateContextText
  readonly component?: SlateContextText
  readonly componentPropsJson?: SlateContextText
}

export interface SlateSelectedCallFrame {
  readonly functionName?: SlateContextText
  readonly url?: SlateContextText
  readonly line?: number
  readonly column?: number
}

export interface SlateSelectedStackTrace {
  readonly frames: readonly SlateSelectedCallFrame[]
  readonly rawText?: SlateContextText
}

export interface SlateSelectedConsoleLog {
  readonly message: SlateContextText
  readonly timestamp: number
  readonly level: string
  readonly clientName: SlateContextText
  readonly sessionId: SlateContextText
  readonly stackTrace?: SlateSelectedStackTrace
  readonly objectDataJson?: SlateContextText
}

export type SlateSelectedExtraContextEntry =
  | { readonly kind: "inline-text"; readonly text: SlateContextText }
  | { readonly kind: "stored-text"; readonly blobId: SlateContextBytes }
  | { readonly kind: "empty" }

export interface SlateSelectedCommit {
  readonly objectId: SlateContextText
  readonly subject: SlateContextText
  readonly explanation?: SlateContextText
  readonly patch: SlateContextText
}

export interface SlateSelectedDiff {
  readonly content: SlateContextText
  readonly fullContentLength: number
}

export interface SlateRelatedConversation {
  readonly id: SlateContextText
  readonly name: SlateContextText
}

export interface SlateSelectedPullRequestDiff {
  readonly url: SlateContextText
  readonly filePath: SlateContextText
  readonly startLine: number
  readonly endLine: number
  readonly diff?: SlateContextText
  readonly blobId?: SlateContextBytes
}

export interface SlateSelectedPullRequest {
  readonly number: number
  readonly url: SlateContextText
  readonly title?: SlateContextText
  readonly localDirectory: SlateContextText
  readonly summaryDocument?: SlateContextText
  readonly description?: SlateContextText
  readonly blobId?: SlateContextBytes
}

export interface SlateSelectedSubagent {
  readonly name: SlateContextText
}

export interface SlateBrowserTabSelection {
  readonly id: SlateContextText
  readonly url: SlateContextText
  readonly title?: SlateContextText
}

export interface SlateSkillSelection {
  readonly path: SlateContextText
  readonly content: SlateContextText
  readonly description: SlateContextText
  readonly parseError?: SlateContextText
  readonly environments: readonly string[]
  readonly disabledEnvironments: readonly string[]
  readonly remoteOrigin?: SlateContextText
  readonly modelInvocationDisabled: boolean
  readonly pluginName?: SlateContextText
  readonly marketplaceName?: SlateContextText
  readonly pluginId?: SlateContextText
  readonly marketplaceId?: SlateContextText
  readonly filePatterns: readonly string[]
  readonly scopedTo: readonly string[]
}

export interface SlateRecentAgentSelection {
  readonly name: SlateContextText
  readonly path: SlateContextText
  readonly overview?: SlateContextText
}

export interface SlateRepositoryBranchContext {
  readonly currentBranch?: SlateContextText
  readonly baseBranch?: SlateContextText
  readonly agentBranchPrefix?: SlateContextText
}

export interface SlateRepositoryFileStatus {
  readonly path: SlateContextText
  readonly status?: SlateContextText
}

export interface SlateRepositoryCommitIntent {
  readonly files: readonly SlateContextText[]
  readonly excludedFiles: readonly SlateContextText[]
  readonly stageAllChanges: boolean
  readonly draftPullRequest?: boolean
  readonly filesWithStatus: readonly SlateRepositoryFileStatus[]
  readonly excludedFilesWithStatus: readonly SlateRepositoryFileStatus[]
}

export type SlateRepositoryActionParameters =
  | { readonly kind: "commit"; readonly commit: SlateRepositoryCommitIntent }
  | { readonly kind: "push"; readonly files: readonly SlateContextText[]; readonly draftPullRequest?: boolean }
  | { readonly kind: "fix-merge-conflicts"; readonly baseBranch?: SlateContextText; readonly pullRequestUrl?: SlateContextText }
  | { readonly kind: "commit-and-push"; readonly commit: SlateRepositoryCommitIntent }
  | { readonly kind: "create-pull-request"; readonly draft?: boolean }
  | { readonly kind: "create-pull-request-with-changes"; readonly commit: SlateRepositoryCommitIntent }
  | { readonly kind: "babysit-pull-request"; readonly baseBranch?: SlateContextText }
  | { readonly kind: "create-branch-and-commit"; readonly commit: SlateRepositoryCommitIntent }
  | { readonly kind: "create-branch-commit-and-push"; readonly commit: SlateRepositoryCommitIntent }
  | { readonly kind: "apply-locally"; readonly remoteBranch: SlateContextText }
  | { readonly kind: "checkout-branch"; readonly remoteBranch: SlateContextText }
  | { readonly kind: "update-branch"; readonly baseBranch?: SlateContextText }
  | { readonly kind: "create-branch" }

export interface SlateRepositoryActionSelection {
  readonly parameters?: SlateRepositoryActionParameters
  readonly branch?: SlateRepositoryBranchContext
  readonly templateFilePath?: SlateContextText
  readonly templateDirectoryPath?: SlateContextText
}

/** Complete Slate-owned source model for the user's selected material on a message. */
export interface SlateSelectedContextState {
  readonly schema: "slate.selected-context"
  readonly version: 1
  readonly media: {
    readonly images: readonly SlateSelectedImageState[]
    readonly videos: readonly SlateSelectedVideoState[]
    readonly documents: readonly SlateSelectedDocumentState[]
  }
  readonly invocation?: SlateInvocationSelectionState
  readonly additionalText: readonly SlateContextText[]
  readonly workspace: {
    readonly files: readonly SlateSelectedWorkspaceFile[]
    readonly codeSelections: readonly SlateSelectedCodeRange[]
    readonly terminalOutputs: readonly SlateSelectedTerminalOutput[]
    readonly terminalRanges: readonly SlateSelectedTerminalRange[]
    readonly folders: readonly SlateSelectedFolderState[]
  }
  readonly externalResources: readonly SlateExternalResourceSelection[]
  readonly rules: readonly SlateSelectedRuleRow[]
  readonly branchDiff?: SlateSelectedDiff
  readonly commands: readonly SlateSelectedCommand[]
  readonly documentation: readonly SlateSelectedDocumentationReference[]
  readonly uiElements: readonly SlateSelectedUIElement[]
  readonly consoleLogs: readonly SlateSelectedConsoleLog[]
  readonly extraEntries: readonly SlateSelectedExtraContextEntry[]
  readonly commits: readonly SlateSelectedCommit[]
  readonly workingTreeDiff?: SlateSelectedDiff
  readonly relatedConversations: readonly SlateRelatedConversation[]
  readonly pullRequestDiffs: readonly SlateSelectedPullRequestDiff[]
  readonly pullRequests: readonly SlateSelectedPullRequest[]
  readonly subagents: readonly SlateSelectedSubagent[]
  readonly browserTabs: readonly SlateBrowserTabSelection[]
  readonly skills: readonly SlateSkillSelection[]
  readonly recentAgents?: readonly SlateRecentAgentSelection[]
  readonly repositoryAction?: SlateRepositoryActionSelection
}

export function emptySlateSelectedContextState(): SlateSelectedContextState {
  return {
    schema: "slate.selected-context",
    version: 1,
    media: { images: [], videos: [], documents: [] },
    additionalText: [],
    workspace: { files: [], codeSelections: [], terminalOutputs: [], terminalRanges: [], folders: [] },
    externalResources: [],
    rules: [],
    commands: [],
    documentation: [],
    uiElements: [],
    consoleLogs: [],
    extraEntries: [],
    commits: [],
    relatedConversations: [],
    pullRequestDiffs: [],
    pullRequests: [],
    subagents: [],
    browserTabs: [],
    skills: [],
  }
}

/** Adds the material selected for a child task to an otherwise empty first-party context record. */
export function selectedContextFromTaskAttachments(
  selection: SlateTaskAttachmentSelection | undefined,
): SlateSelectedContextState | undefined {
  if (selection === undefined) return undefined
  const base = emptySlateSelectedContextState()
  return {
    ...base,
    media: {
      images: selection.images.map(image => {
        let content: SlateSelectedImageState["content"]
        switch (image.content?.kind) {
          case "inline-bytes": content = { kind: "inline", bytes: new Uint8Array(image.content.bytes) }; break
          case "stored-blob": content = { kind: "stored", blobId: new Uint8Array(image.content.blobId) }; break
          case "blob-with-bytes": content = { kind: "stored-with-inline", blobId: new Uint8Array(image.content.blobId), bytes: new Uint8Array(image.content.bytes) }; break
          case "unresolved-upload": content = { kind: "upload", uploadId: image.content.uploadId }; break
          default: content = undefined
        }
        return {
          id: image.id,
          path: image.sourcePath,
          mediaType: image.mediaType,
          ...(image.dimensions === undefined ? {} : { dimensions: { ...image.dimensions } }),
          ...(content === undefined ? {} : { content }),
        }
      }),
      videos: selection.videos.map(video => {
        let content: SlateSelectedVideoState["content"]
        switch (video.content.kind) {
          case "bytes": content = { kind: "inline", bytes: new Uint8Array(video.content.bytes) }; break
          case "blob": content = { kind: "stored", blobId: new Uint8Array(video.content.blobId) }; break
          case "blob-with-bytes": content = { kind: "stored-with-inline", blobId: new Uint8Array(video.content.blobId), bytes: new Uint8Array(video.content.bytes) }; break
          case "signed-link": content = { ...video.content, kind: "signed-link", expiresAtUnixMs: video.content.expiresAtUnixMs ?? 0n, refreshAfterUnixMs: video.content.refreshAfterUnixMs ?? 0n, key: video.content.key ?? "" }; break
          case "empty": content = { kind: "empty" }; break
        }
        return {
          id: video.id ?? "",
          path: video.sourcePath,
          displayName: video.displayName,
          mediaType: video.mediaType,
          ...(video.frameRate === undefined ? {} : { frameRate: video.frameRate }),
          writeToWorkspace: video.writeToWorkspace,
          content,
        }
      }),
      documents: [],
    },
    commands: selection.commands.map(command => ({
      name: command.name,
      content: command.content,
      ...(command.sourcePath === undefined ? {} : { sourcePath: command.sourcePath }),
      ...(command.displayName === undefined ? {} : { displayName: command.displayName }),
      ...(command.capability === undefined ? {} : { capability: {
        pluginId: command.capability.pluginId,
        capability: command.capability.capability,
        sourcePath: command.capability.sourcePath,
        snapshotToken: command.capability.snapshotToken,
        ...(command.capability.resolvedCommit === undefined ? {} : { resolvedCommit: command.capability.resolvedCommit }),
      } }),
    })),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isText(value: unknown): value is SlateContextText {
  return typeof value === "string" || value instanceof RedactedString
}

function isBytes(value: unknown): value is SlateContextBytes {
  return value instanceof Uint8Array || value instanceof RedactedBytes
}

function isOptional(value: unknown, predicate: (candidate: unknown) => boolean): boolean {
  return value === undefined || predicate(value)
}

function every(value: unknown, predicate: (candidate: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(predicate)
}

function isNumber(value: unknown): value is number {
  return typeof value === "number"
}

function isPosition(value: unknown): value is SlateSelectedPosition {
  return isRecord(value) && Number.isInteger(value.line) && Number.isInteger(value.column)
}

function isRange(value: unknown): value is SlateSelectedRange {
  return isRecord(value) && isOptional(value.start, isPosition) && isOptional(value.end, isPosition)
}

function isImageContent(value: unknown): value is SlateSelectedImageContent {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case "inline": return isBytes(value.bytes)
    case "stored": return isBytes(value.blobId)
    case "stored-with-inline": return isBytes(value.blobId) && isBytes(value.bytes)
    case "upload": return isText(value.uploadId)
    default: return false
  }
}

function isImage(value: unknown): value is SlateSelectedImageState {
  return isRecord(value) && typeof value.id === "string" && isText(value.path) && typeof value.mediaType === "string" &&
    isOptional(value.dimensions, dimensions => isRecord(dimensions) && isNumber(dimensions.width) && isNumber(dimensions.height)) &&
    isOptional(value.content, isImageContent)
}

function isVideoContent(value: unknown): value is SlateSelectedVideoContent {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case "inline": return isBytes(value.bytes)
    case "stored": return isBytes(value.blobId)
    case "stored-with-inline": return isBytes(value.blobId) && isBytes(value.bytes)
    case "signed-link":
      return isText(value.url) && typeof value.key === "string" && typeof value.expiresAtUnixMs === "bigint" &&
        typeof value.refreshAfterUnixMs === "bigint" && typeof value.conversationId === "string"
    case "empty": return true
    default: return false
  }
}

function isVideo(value: unknown): value is SlateSelectedVideoState {
  return isRecord(value) && typeof value.id === "string" && isText(value.path) && isText(value.displayName) &&
    typeof value.mediaType === "string" && isOptional(value.frameRate, isNumber) &&
    typeof value.writeToWorkspace === "boolean" && isVideoContent(value.content)
}

function isDocumentContent(value: unknown): value is SlateSelectedDocumentContent {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case "inline": return isBytes(value.bytes)
    case "stored": return isBytes(value.blobId)
    case "stored-with-inline": return isBytes(value.blobId) && isBytes(value.bytes)
    case "upload": return isText(value.uploadId)
    case "empty": return true
    default: return false
  }
}

function isDocument(value: unknown): value is SlateSelectedDocumentState {
  return isRecord(value) && typeof value.id === "string" && isText(value.displayName) &&
    typeof value.mediaType === "string" && isText(value.path) && isDocumentContent(value.content)
}

function isInvocationFile(value: unknown): value is SlateInvocationEditorFile {
  return isRecord(value) && isText(value.path) && isOptional(value.relativePath, isText) &&
    isOptional(value.cursor, cursor => isRecord(cursor) && Number.isInteger(cursor.line) && isText(cursor.text)) &&
    Number.isInteger(value.totalLines) && isOptional(value.activeCommand, isText)
}

function isViewedChange(value: unknown): value is SlateInvocationViewedChange {
  return isRecord(value) && Number.isInteger(value.number) && isText(value.url) &&
    isOptional(value.title, isText) && isOptional(value.localDirectory, isText) &&
    isOptional(value.summaryDocument, isText) && isOptional(value.description, isText)
}

function isInvocation(value: unknown): value is SlateInvocationSelectionState {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case "conversation": {
      const context = value.context
      if (!isRecord(context) || (context.platform !== "slack" && context.platform !== "microsoft-teams") ||
          !isText(context.body) || isOptional(context.directlyAddressed, candidate => typeof candidate === "boolean")) return false
      if (!isOptional(context.channel, candidate => isRecord(candidate) &&
          ["workspaceName", "workspaceDescription", "name", "description", "purpose", "topic", "teamName", "teamDescription"].every(key => isOptional(candidate[key], isText)))) return false
      return isOptional(context.sender, candidate => isRecord(candidate) &&
        ["name", "id", "kind"].every(key => isOptional(candidate[key], isText)))
    }
    case "change-review":
      return isText(value.title) && isText(value.description) && isText(value.comments) && isOptional(value.buildFailures, isText)
    case "editor":
      return isRecord(value.state) && every(value.state.visibleFiles, isInvocationFile) &&
        every(value.state.recentlyViewedFiles, isInvocationFile) && every(value.state.viewedChanges, isViewedChange)
    case "stored": return isBytes(value.blobId)
    case "unsupported": return true
    default: return false
  }
}

function isDirectoryNode(value: unknown, ancestors = new Set<object>()): value is SlateSelectedDirectoryNode {
  if (!isRecord(value) || ancestors.has(value) || !isText(value.path) || typeof value.processed !== "boolean" ||
      !Number.isInteger(value.fileCount) || !isRecord(value.extensionCounts) ||
      !Object.values(value.extensionCounts).every(isNumber) ||
      !every(value.files, file => isRecord(file) && isText(file.name) &&
        isOptional(file.terminalMetadata, metadata => isRecord(metadata) &&
          isOptional(metadata.cwd, isText) && isOptional(metadata.lastModifiedMs, candidate => typeof candidate === "bigint") &&
          isOptional(metadata.lastCommands, commands => every(commands, isDirectoryCommand)) &&
          isOptional(metadata.currentCommand, isDirectoryCommand)))) return false
  ancestors.add(value)
  const childrenValid = every(value.directories, child => isDirectoryNode(child, ancestors))
  ancestors.delete(value)
  return childrenValid
}

function isDirectoryCommand(value: unknown): boolean {
  return isRecord(value) && isText(value.command) && isOptional(value.exitCode, Number.isInteger) &&
    isOptional(value.timestampMs, candidate => typeof candidate === "bigint") &&
    isOptional(value.durationMs, candidate => typeof candidate === "bigint")
}

function isWorkspaceRuleType(value: unknown): value is SlateWorkspaceRuleType {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case "global":
    case "manual": return true
    case "file-patterns": return every(value.patterns, (item): item is string => typeof item === "string")
    case "suggested": return isText(value.description)
    case "unknown": return typeof value.wireCase === "string"
    default: return false
  }
}

function isWorkspaceRule(value: unknown): value is SlateWorkspaceRule {
  return isRecord(value) && isText(value.path) && isText(value.content) &&
    isOptional(value.type, isWorkspaceRuleType) &&
    typeof value.source === "string" && (value.source === "unspecified" || value.source === "team" || value.source === "user" || /^unknown-(-?\d+)$/.test(value.source)) &&
    isOptional(value.remoteOrigin, isText) && isOptional(value.parseError, isText) &&
    every(value.environments, (item): item is string => typeof item === "string") &&
    every(value.disabledEnvironments, (item): item is string => typeof item === "string") &&
    isOptional(value.pluginName, isText) && isOptional(value.marketplaceName, isText) &&
    isOptional(value.pluginId, isText) && isOptional(value.marketplaceId, isText) &&
    every(value.scopedTo, (item): item is string => typeof item === "string") && isText(value.frontmatter) &&
    isOptional(value.required, candidate => typeof candidate === "boolean")
}

function isCommandCapability(value: unknown): value is SlatePluginCapabilitySelection {
  return isRecord(value) && typeof value.pluginId === "string" && typeof value.capability === "string" &&
    (value.capability === "unspecified" || value.capability === "command" || value.capability === "skill" ||
      value.capability === "subagent" || /^unknown-(-?\d+)$/.test(value.capability)) &&
    isText(value.sourcePath) && isText(value.snapshotToken) && isOptional(value.resolvedCommit, candidate => typeof candidate === "string")
}

function isCommand(value: unknown): boolean {
  return isRecord(value) && typeof value.name === "string" && isText(value.content) &&
    isOptional(value.sourcePath, isText) && isOptional(value.displayName, isText) &&
    isOptional(value.capability, isCommandCapability)
}

function isStackTrace(value: unknown): value is SlateSelectedStackTrace {
  return isRecord(value) && every(value.frames, frame => isRecord(frame) &&
    isOptional(frame.functionName, isText) && isOptional(frame.url, isText) &&
    isOptional(frame.line, Number.isInteger) && isOptional(frame.column, Number.isInteger)) &&
    isOptional(value.rawText, isText)
}

function isConsoleLog(value: unknown): value is SlateSelectedConsoleLog {
  return isRecord(value) && isText(value.message) && isNumber(value.timestamp) && typeof value.level === "string" &&
    isText(value.clientName) && isText(value.sessionId) && isOptional(value.stackTrace, isStackTrace) &&
    isOptional(value.objectDataJson, isText)
}

function isExtraEntry(value: unknown): value is SlateSelectedExtraContextEntry {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case "inline-text": return isText(value.text)
    case "stored-text": return isBytes(value.blobId)
    case "empty": return true
    default: return false
  }
}

function isCommit(value: unknown): value is SlateSelectedCommit {
  return isRecord(value) && isText(value.objectId) && isText(value.subject) &&
    isOptional(value.explanation, isText) && isText(value.patch)
}

function isDiff(value: unknown): value is SlateSelectedDiff {
  return isRecord(value) && isText(value.content) && Number.isInteger(value.fullContentLength)
}

function isPullRequestDiff(value: unknown): value is SlateSelectedPullRequestDiff {
  return isRecord(value) && isText(value.url) && isText(value.filePath) && Number.isInteger(value.startLine) &&
    Number.isInteger(value.endLine) && isOptional(value.diff, isText) && isOptional(value.blobId, isBytes)
}

function isPullRequest(value: unknown): value is SlateSelectedPullRequest {
  return isRecord(value) && Number.isInteger(value.number) && isText(value.url) && isOptional(value.title, isText) &&
    isText(value.localDirectory) && isOptional(value.summaryDocument, isText) &&
    isOptional(value.description, isText) && isOptional(value.blobId, isBytes)
}

function isRepositoryCommit(value: unknown): value is SlateRepositoryCommitIntent {
  return isRecord(value) && every(value.files, isText) && every(value.excludedFiles, isText) &&
    typeof value.stageAllChanges === "boolean" && isOptional(value.draftPullRequest, candidate => typeof candidate === "boolean") &&
    every(value.filesWithStatus, file => isRecord(file) && isText(file.path) && isOptional(file.status, isText)) &&
    every(value.excludedFilesWithStatus, file => isRecord(file) && isText(file.path) && isOptional(file.status, isText))
}

function isRepositoryActionParameters(value: unknown): value is SlateRepositoryActionParameters {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case "commit":
    case "commit-and-push":
    case "create-branch-and-commit":
    case "create-branch-commit-and-push":
    case "create-pull-request-with-changes": return isRepositoryCommit(value.commit)
    case "push": return every(value.files, isText) && isOptional(value.draftPullRequest, candidate => typeof candidate === "boolean")
    case "fix-merge-conflicts": return isOptional(value.baseBranch, isText) && isOptional(value.pullRequestUrl, isText)
    case "create-pull-request": return isOptional(value.draft, candidate => typeof candidate === "boolean")
    case "babysit-pull-request":
    case "update-branch": return isOptional(value.baseBranch, isText)
    case "apply-locally":
    case "checkout-branch": return isText(value.remoteBranch)
    case "create-branch": return true
    default: return false
  }
}

function isRepositoryAction(value: unknown): value is SlateRepositoryActionSelection {
  return isRecord(value) && isOptional(value.parameters, isRepositoryActionParameters) &&
    isOptional(value.branch, branch => isRecord(branch) && isOptional(branch.currentBranch, isText) &&
      isOptional(branch.baseBranch, isText) && isOptional(branch.agentBranchPrefix, isText)) &&
    isOptional(value.templateFilePath, isText) && isOptional(value.templateDirectoryPath, isText)
}

/** Guards the versioned Slate root before it crosses storage or application boundaries. */
export function isSlateSelectedContextState(value: unknown): value is SlateSelectedContextState {
  if (!isRecord(value) || value.schema !== "slate.selected-context" || value.version !== 1 ||
      !isRecord(value.media) || !isRecord(value.workspace)) return false
  return every(value.media.images, isImage) && every(value.media.videos, isVideo) &&
    every(value.media.documents, isDocument) && isOptional(value.invocation, isInvocation) &&
    every(value.additionalText, isText) &&
    every(value.workspace.files, file => isRecord(file) && isText(file.path) && isText(file.content) && isOptional(file.relativePath, isText)) &&
    every(value.workspace.codeSelections, selection => isRecord(selection) && isText(selection.path) && isText(selection.content) && isOptional(selection.relativePath, isText) && isOptional(selection.range, isRange)) &&
    every(value.workspace.terminalOutputs, terminal => isRecord(terminal) && isText(terminal.content) && isOptional(terminal.title, isText) && isOptional(terminal.path, isText)) &&
    every(value.workspace.terminalRanges, terminal => isRecord(terminal) && isText(terminal.content) && isOptional(terminal.title, isText) && isOptional(terminal.path, isText) && isOptional(terminal.range, isRange)) &&
    every(value.workspace.folders, folder => isRecord(folder) && isText(folder.path) && isOptional(folder.relativePath, isText) && isOptional(folder.tree, isDirectoryNode)) &&
    every(value.externalResources, link => isRecord(link) && typeof link.id === "string" && isText(link.url) && isOptional(link.pdfText, isText) && isOptional(link.isPdf, candidate => typeof candidate === "boolean") && isOptional(link.displayName, isText) && isOptional(link.blobId, isBytes)) &&
    every(value.rules, row => isRecord(row) && isOptional(row.rule, isWorkspaceRule)) &&
    isOptional(value.branchDiff, isDiff) && every(value.commands, isCommand) &&
    every(value.documentation, document => isRecord(document) && isText(document.id) && isText(document.displayName)) &&
    every(value.uiElements, element => isRecord(element) && isText(element.element) && isText(element.xpath) && isText(element.textContent) && isText(element.additionalContext) && isOptional(element.component, isText) && isOptional(element.componentPropsJson, isText)) &&
    every(value.consoleLogs, isConsoleLog) && every(value.extraEntries, isExtraEntry) && every(value.commits, isCommit) &&
    isOptional(value.workingTreeDiff, isDiff) &&
    every(value.relatedConversations, item => isRecord(item) && isText(item.id) && isText(item.name)) &&
    every(value.pullRequestDiffs, isPullRequestDiff) && every(value.pullRequests, isPullRequest) &&
    every(value.subagents, item => isRecord(item) && isText(item.name)) &&
    every(value.browserTabs, tab => isRecord(tab) && isText(tab.id) && isText(tab.url) && isOptional(tab.title, isText)) &&
    every(value.skills, skill => isRecord(skill) && isText(skill.path) && isText(skill.content) && isText(skill.description) &&
      isOptional(skill.parseError, isText) && every(skill.environments, (item): item is string => typeof item === "string") &&
      every(skill.disabledEnvironments, (item): item is string => typeof item === "string") &&
      isOptional(skill.remoteOrigin, isText) && typeof skill.modelInvocationDisabled === "boolean" &&
      isOptional(skill.pluginName, isText) && isOptional(skill.marketplaceName, isText) &&
      isOptional(skill.pluginId, isText) && isOptional(skill.marketplaceId, isText) &&
      every(skill.filePatterns, (item): item is string => typeof item === "string") &&
      every(skill.scopedTo, (item): item is string => typeof item === "string")) &&
    isOptional(value.recentAgents, agents => every(agents, agent => isRecord(agent) && isText(agent.name) && isText(agent.path) && isOptional(agent.overview, isText))) &&
    isOptional(value.repositoryAction, isRepositoryAction)
}

function cloneContextBytes(value: SlateContextBytes): SlateContextBytes {
  return value instanceof RedactedBytes
    ? value.safeTransform(bytes => new Uint8Array(bytes))
    : new Uint8Array(value)
}

function cloneValue<T>(value: T): T {
  if (value instanceof RedactedString) return value
  if (value instanceof RedactedBytes) return cloneContextBytes(value) as T
  if (value instanceof Uint8Array) return new Uint8Array(value) as T
  if (Array.isArray(value)) return value.map(entry => cloneValue(entry)) as T
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)])) as T
  }
  return value
}

/** Copies mutable attachment bytes and nested selections without unwrapping privacy metadata. */
export function cloneSlateSelectedContextState(
  value: SlateSelectedContextState,
): SlateSelectedContextState {
  return cloneValue(value)
}
