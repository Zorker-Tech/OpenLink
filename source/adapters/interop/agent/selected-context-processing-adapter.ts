import { SimulatedMsgReason } from "../proto/generated/agent/v1/agent_pb.ts"
import type { SimulatedMsgReason as InteropSimulatedMsgReason } from "../proto/generated/agent/v1/agent_pb.ts"
import { SelectedContext } from "../proto/generated/agent/v1/selected_context_pb.ts"
import type { TaskToolModelInfo } from "../../../packages/agent/tools/task-tool-name.ts"
import type { SlateInvocationSelection, SlateSelectedContextForProcessing } from "../../../packages/agent/context/selected-context-processing-contracts.ts"
import {
  isSlateSelectedContextState,
  type SlateContextText,
  type SlateInvocationEditorFile,
  type SlateInvocationViewedChange,
  type SlateSelectedContextState,
  type SlateSelectedDirectoryNode,
} from "../../../packages/agent/context/selected-context-state.ts"
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
import { renderSlateSelectedContextSimulatedMessagePrompts } from "./git-action-prompt-adapter.ts"
import { copySelectedContextBytes } from "./selected-context-value-adapter.ts"
import type { SlateImageAttachment } from "../../../packages/agent/context/image-attachment-contracts.ts"
import type { SlateVideoAttachment, SlateVideoContent } from "../../../packages/agent/context/video-attachment-contracts.ts"
import type { SlateDocumentAttachment } from "../../../packages/agent/context/document-attachment-contracts.ts"
import type { SlateDirectoryTreeNode } from "../../../packages/agent/tools/core/ls/directory-tree-contracts.ts"
import type { InvocationEditorFile, InvocationViewedPullRequest } from "../../../packages/agent/context/invocation-platforms.ts"
import { fromInteropSimulatedMessageReason } from "./user-message-action-protocol-adapter.ts"

function contextText(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (value instanceof RedactedString) return value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  return undefined
}

function stateText(value: SlateContextText): string {
  return contextText(value) ?? ""
}

function stateImage(image: SlateSelectedContextState["media"]["images"][number]): SlateImageAttachment {
  let content: SlateImageAttachment["content"]
  switch (image.content?.kind) {
    case "inline": content = { kind: "inline-bytes", bytes: copySelectedContextBytes(image.content.bytes, "image data") }; break
    case "stored": content = { kind: "stored-blob", blobId: copySelectedContextBytes(image.content.blobId, "image blob id") }; break
    case "stored-with-inline": content = { kind: "blob-with-bytes", blobId: copySelectedContextBytes(image.content.blobId, "image blob id"), bytes: copySelectedContextBytes(image.content.bytes, "image data") }; break
    case "upload": content = { kind: "unresolved-upload", uploadId: stateText(image.content.uploadId) }; break
    default: content = undefined
  }
  return {
    id: image.id,
    sourcePath: stateText(image.path),
    mediaType: image.mediaType,
    ...(image.dimensions === undefined ? {} : { dimensions: { ...image.dimensions } }),
    ...(content === undefined ? {} : { content }),
  }
}

function stateVideo(video: SlateSelectedContextState["media"]["videos"][number]): SlateVideoAttachment {
  let content: SlateVideoContent
  switch (video.content.kind) {
    case "inline": content = { kind: "bytes", bytes: copySelectedContextBytes(video.content.bytes, "video data") }; break
    case "stored": content = { kind: "blob", blobId: copySelectedContextBytes(video.content.blobId, "video blob id") }; break
    case "stored-with-inline": content = { kind: "blob-with-bytes", blobId: copySelectedContextBytes(video.content.blobId, "video blob id"), bytes: copySelectedContextBytes(video.content.bytes, "video data") }; break
    case "signed-link": content = { kind: "signed-link", url: stateText(video.content.url), key: video.content.key, expiresAtUnixMs: video.content.expiresAtUnixMs, refreshAfterUnixMs: video.content.refreshAfterUnixMs, conversationId: video.content.conversationId }; break
    case "empty": content = { kind: "empty" }; break
  }
  return {
    ...(video.id.length === 0 ? {} : { id: video.id }),
    sourcePath: stateText(video.path),
    displayName: stateText(video.displayName),
    mediaType: video.mediaType,
    ...(video.frameRate === undefined ? {} : { frameRate: video.frameRate }),
    writeToWorkspace: video.writeToWorkspace,
    content,
  }
}

function stateDocument(document: SlateSelectedContextState["media"]["documents"][number]): SlateDocumentAttachment {
  let content: SlateDocumentAttachment["content"]
  switch (document.content.kind) {
    case "inline": content = { kind: "inline-bytes", bytes: copySelectedContextBytes(document.content.bytes, "document data") }; break
    case "stored": content = { kind: "stored-blob", blobId: copySelectedContextBytes(document.content.blobId, "document blob id") }; break
    case "stored-with-inline": content = { kind: "blob-with-bytes", blobId: copySelectedContextBytes(document.content.blobId, "document blob id"), bytes: copySelectedContextBytes(document.content.bytes, "document data") }; break
    case "upload": content = { kind: "unresolved-upload-reference", uploadId: stateText(document.content.uploadId) }; break
    case "empty": content = undefined; break
  }
  return { uuid: document.id, filename: stateText(document.displayName), mimeType: document.mediaType, path: stateText(document.path), content }
}

function stateInvocation(selection: SlateSelectedContextState["invocation"]): SlateInvocationSelection | undefined {
  if (selection === undefined) return undefined
  switch (selection.kind) {
    case "stored": return { kind: "stored", blobId: copySelectedContextBytes(selection.blobId, "invocation blob id") }
    case "unsupported": return { kind: "inline", context: { kind: "unsupported" } }
    case "change-review": return {
      kind: "inline",
      context: {
        kind: "pull_request",
        pullRequest: {
          title: stateText(selection.title),
          description: stateText(selection.description),
          reviewComments: stateText(selection.comments),
          ...(selection.buildFailures === undefined ? {} : { buildFailures: stateText(selection.buildFailures) }),
        },
      },
    }
    case "conversation": {
      const channel = selection.context.channel
      const sender = selection.context.sender
      const channelRecord = selection.context.platform === "slack"
        ? {
            workspaceName: undefined,
            workspaceDescription: undefined,
            channelName: channel?.name === undefined ? undefined : stateText(channel.name),
            channelDescription: undefined,
            purpose: channel?.purpose === undefined ? undefined : stateText(channel.purpose),
            topic: channel?.topic === undefined ? undefined : stateText(channel.topic),
          }
        : {
            workspaceName: channel?.teamName === undefined ? undefined : stateText(channel.teamName),
            workspaceDescription: channel?.teamDescription === undefined ? undefined : stateText(channel.teamDescription),
            channelName: channel?.name === undefined ? undefined : stateText(channel.name),
            channelDescription: channel?.description === undefined ? undefined : stateText(channel.description),
            purpose: undefined,
            topic: undefined,
          }
      const senderRecord = selection.context.platform === "slack"
        ? {
            name: sender?.name === undefined ? undefined : stateText(sender.name),
            id: sender?.id === undefined ? undefined : stateText(sender.id),
            kind: sender?.kind === undefined ? undefined : stateText(sender.kind),
          }
        : undefined
      return {
        kind: "inline",
        context: {
          kind: "conversation",
          conversation: {
            body: stateText(selection.context.body),
            channel: channelRecord,
            ...(senderRecord === undefined ? {} : { sender: senderRecord }),
          },
        },
      }
    }
    case "editor": {
      const editorFile = (file: SlateInvocationEditorFile): InvocationEditorFile => ({
        path: stateText(file.path),
        totalLines: file.totalLines,
        activeCommand: file.activeCommand === undefined ? undefined : stateText(file.activeCommand),
        ...(file.cursor === undefined ? {} : { cursorLine: file.cursor.line }),
      })
      const viewedChange = (change: SlateInvocationViewedChange): InvocationViewedPullRequest => ({
        number: change.number,
        title: change.title === undefined ? undefined : stateText(change.title),
        url: stateText(change.url),
        description: change.description === undefined ? undefined : stateText(change.description),
        reviewDirectory: change.localDirectory === undefined ? undefined : stateText(change.localDirectory),
        summaryDocument: change.summaryDocument === undefined ? undefined : stateText(change.summaryDocument),
      })
      return {
        kind: "inline",
        context: {
          kind: "editor",
          editor: {
            visibleFiles: selection.state.visibleFiles.map(editorFile),
            recentlyViewedFiles: selection.state.recentlyViewedFiles.map(editorFile),
            openPullRequests: selection.state.viewedChanges.map(viewedChange),
          },
        },
      }
    }
  }
}

function stateDirectoryTree(node: SlateSelectedDirectoryNode | undefined): SlateDirectoryTreeNode | undefined {
  if (node === undefined) return undefined
  const command = (value: { readonly command: SlateContextText; readonly exitCode?: number; readonly timestampMs?: bigint; readonly durationMs?: bigint }) => ({
    command: stateText(value.command),
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
    ...(value.timestampMs === undefined ? {} : { timestampMs: value.timestampMs }),
    ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
  })
  return {
    absPath: stateText(node.path),
    childrenWereProcessed: node.processed,
    childrenFiles: node.files.map(file => ({
      name: stateText(file.name),
      ...(file.terminalMetadata === undefined ? {} : { terminalMetadata: {
        ...(file.terminalMetadata.cwd === undefined ? {} : { cwd: stateText(file.terminalMetadata.cwd) }),
        ...(file.terminalMetadata.lastModifiedMs === undefined ? {} : { lastModifiedMs: file.terminalMetadata.lastModifiedMs }),
        lastCommands: file.terminalMetadata.lastCommands?.map(command) ?? [],
        ...(file.terminalMetadata.currentCommand === undefined ? {} : { currentCommand: command(file.terminalMetadata.currentCommand) }),
      } }),
    })),
    childrenDirs: node.directories.map(child => stateDirectoryTree(child)!),
    numFiles: node.fileCount,
    fullSubtreeExtensionCounts: { ...node.extensionCounts },
  }
}

function projectSlateSelectedContextForProcessing(
  selectedContext: SlateSelectedContextState,
  options: SelectedContextProcessingProjectionOptions,
): SlateSelectedContextForProcessing {
  const invocation = stateInvocation(selectedContext.invocation)
  const recentAgents = selectedContext.recentAgents ?? []
  const skills = selectedContext.skills.map(skill => ({
    path: stateText(skill.path),
    text: stateText(skill.content),
    pluginName: skill.pluginName === undefined ? undefined : stateText(skill.pluginName),
    marketplaceName: skill.marketplaceName === undefined ? undefined : stateText(skill.marketplaceName),
    pluginId: skill.pluginId === undefined ? undefined : stateText(skill.pluginId),
    marketplaceId: skill.marketplaceId === undefined ? undefined : stateText(skill.marketplaceId),
  }))
  const rules = selectedContext.rules.map(row => row.rule === undefined ? undefined : ({
    path: stateText(row.rule.path),
    text: stateText(row.rule.content),
    pluginName: row.rule.pluginName === undefined ? undefined : stateText(row.rule.pluginName),
    marketplaceName: row.rule.marketplaceName === undefined ? undefined : stateText(row.rule.marketplaceName),
    pluginId: row.rule.pluginId === undefined ? undefined : stateText(row.rule.pluginId),
    marketplaceId: row.rule.marketplaceId === undefined ? undefined : stateText(row.rule.marketplaceId),
  }))
  return {
    images: selectedContext.media.images.map(stateImage),
    videos: selectedContext.media.videos.map(stateVideo),
    documents: selectedContext.media.documents.map(stateDocument),
    ...(invocation === undefined ? {} : { invocation }),
    workspace: {
      files: selectedContext.workspace.files.map(file => ({ path: stateText(file.path), content: stateText(file.content), ...(file.relativePath === undefined ? {} : { relativePath: stateText(file.relativePath) }) })),
      codeSelections: selectedContext.workspace.codeSelections.map(selection => ({ path: stateText(selection.path), content: stateText(selection.content), ...(selection.range === undefined ? {} : { range: { ...(selection.range.start === undefined ? {} : { start: { ...selection.range.start } }), ...(selection.range.end === undefined ? {} : { end: { ...selection.range.end } }) } }) })),
      terminals: selectedContext.workspace.terminalOutputs.map(terminal => ({ content: stateText(terminal.content), ...(terminal.title === undefined ? {} : { title: stateText(terminal.title) }), ...(terminal.path === undefined ? {} : { path: stateText(terminal.path) }) })),
      terminalSelections: selectedContext.workspace.terminalRanges.map(selection => ({ content: stateText(selection.content), ...(selection.title === undefined ? {} : { title: stateText(selection.title) }), ...(selection.path === undefined ? {} : { path: stateText(selection.path) }), ...(selection.range === undefined ? {} : { range: { ...(selection.range.start === undefined ? {} : { start: { ...selection.range.start } }), ...(selection.range.end === undefined ? {} : { end: { ...selection.range.end } }) } }) })),
      folders: selectedContext.workspace.folders.map(folder => {
        const directoryTree = stateDirectoryTree(folder.tree)
        return { path: stateText(folder.path), ...(folder.relativePath === undefined ? {} : { relativePath: stateText(folder.relativePath) }), ...(directoryTree === undefined ? {} : { directoryTree }) }
      }),
    },
    externalLinkUrls: selectedContext.externalResources.map(link => stateText(link.url)),
    documentReferences: selectedContext.documentation.map(document => ({ id: stateText(document.id), displayName: stateText(document.displayName) })),
    pullRequests: selectedContext.pullRequests.map(pr => ({ number: pr.number, url: stateText(pr.url), localReviewDirectory: stateText(pr.localDirectory), ...(pr.title === undefined ? {} : { title: stateText(pr.title) }), ...(pr.summaryDocument === undefined ? {} : { summaryDocument: stateText(pr.summaryDocument) }), ...(pr.description === undefined ? {} : { description: stateText(pr.description) }), ...(pr.blobId === undefined ? {} : { blobId: copySelectedContextBytes(pr.blobId, "pull-request blob id") }) })),
    pullRequestDiffs: selectedContext.pullRequestDiffs.map(diff => ({ url: stateText(diff.url), filePath: stateText(diff.filePath), startLine: diff.startLine, endLine: diff.endLine, ...(diff.diff === undefined ? {} : { diff: stateText(diff.diff) }), ...(diff.blobId === undefined ? {} : { blobId: copySelectedContextBytes(diff.blobId, "pull-request diff blob id") }) })),
    extraContextEntries: selectedContext.extraEntries.map(entry => {
      switch (entry.kind) {
        case "inline-text": return { kind: "inline-text", text: stateText(entry.text) }
        case "stored-text": return { kind: "stored-text", blobId: copySelectedContextBytes(entry.blobId, "extra-context blob id") }
        case "empty": return { kind: "empty" }
      }
    }),
    extraContextText: selectedContext.additionalText.map(value => stateText(value)),
    skillAttachments: { explicitSkills: skills, ruleCandidates: rules },
    nonMedia: {
      attachedCommands: selectedContext.commands.map(command => ({ name: command.name, content: stateText(command.content), ...(command.sourcePath === undefined ? {} : { sourcePath: stateText(command.sourcePath) }) })),
      ...(selectedContext.workingTreeDiff === undefined ? {} : { gitDiff: { content: stateText(selectedContext.workingTreeDiff.content), fullContentLengthCharCount: selectedContext.workingTreeDiff.fullContentLength } }),
      ...(selectedContext.branchDiff === undefined ? {} : { gitDiffFromBranchToMain: { content: stateText(selectedContext.branchDiff.content), fullContentLengthCharCount: selectedContext.branchDiff.fullContentLength } }),
      gitCommits: selectedContext.commits.map(commit => ({ objectId: stateText(commit.objectId), subject: stateText(commit.subject), ...(commit.explanation === undefined ? {} : { explanation: stateText(commit.explanation) }), patch: stateText(commit.patch) })),
    },
    recentAgents: recentAgents.map(agent => ({ name: stateText(agent.name), path: stateText(agent.path), ...(agent.overview === undefined ? {} : { overview: stateText(agent.overview) }) })),
    uiElements: selectedContext.uiElements.map(element => ({ element: stateText(element.element), xpath: stateText(element.xpath), textContent: stateText(element.textContent), ...(element.component === undefined ? {} : { component: stateText(element.component) }), ...(element.componentPropsJson === undefined ? {} : { componentPropsJson: stateText(element.componentPropsJson) }) })),
    browserTabs: selectedContext.browserTabs.map(tab => ({ url: stateText(tab.url), browserId: stateText(tab.id), ...(tab.title === undefined ? {} : { pageTitle: stateText(tab.title) }) })),
    selectedSubagents: selectedContext.subagents.map(agent => ({ name: stateText(agent.name) })),
    consoleLogs: selectedContext.consoleLogs.map(log => ({ level: log.level, timestamp: log.timestamp, message: stateText(log.message) })),
    simulatedMessagePrompts: renderSlateSelectedContextSimulatedMessagePrompts({
      ...(selectedContext.repositoryAction === undefined ? {} : { action: selectedContext.repositoryAction }),
      reason: options.simulatedMsgReason === undefined ? undefined : fromInteropSimulatedMessageReason(options.simulatedMsgReason),
      ...(options.modelInfo === undefined ? {} : { modelInfo: options.modelInfo }),
      ...(options.environmentParamForSubagent === undefined ? {} : { environmentParamForSubagent: options.environmentParamForSubagent }),
      ...(options.babysitV2Prompt === undefined ? {} : { babysitV2Prompt: options.babysitV2Prompt }),
      ...(options.enablePrCreationForgeGuidance === undefined ? {} : { enablePrCreationForgeGuidance: options.enablePrCreationForgeGuidance }),
    }),
  }
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
  source: SelectedContext | SlateSelectedContextState | undefined,
  options: SelectedContextProcessingProjectionOptions = {},
): SlateSelectedContextForProcessing {
  if (source !== undefined && isSlateSelectedContextState(source)) {
    return projectSlateSelectedContextForProcessing(source, options)
  }
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
