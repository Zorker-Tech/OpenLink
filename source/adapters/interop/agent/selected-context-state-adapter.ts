import {
  SelectedContext,
  SelectedPluginCapabilityType,
  type SelectedAgenticGitAction,
  type SelectedAgenticGitActionCommitParams,
} from "../proto/generated/agent/v1/selected_context_pb.ts"
import { CursorRuleSource } from "../proto/generated/agent/v1/rules_pb.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import { RedactedBytes } from "../../../packages/redaction/redacted-values.ts"
import { RedactedString } from "../../../packages/redaction/redacted-values.ts"
import type {
  SlateBrowserTabSelection,
  SlateContextBytes,
  SlateContextText,
  SlateInvocationSelectionState,
  SlateRepositoryActionSelection,
  SlateRepositoryActionParameters,
  SlateRepositoryCommitIntent,
  SlateSelectedCodeRange,
  SlateSelectedContextState,
  SlateSelectedDirectoryNode,
  SlateSelectedDocumentState,
  SlateSelectedExtraContextEntry,
  SlateSelectedFolderState,
  SlateSelectedImageState,
  SlateSelectedPosition,
  SlateSelectedPullRequest,
  SlateSelectedPullRequestDiff,
  SlateSelectedRange,
  SlateSelectedRuleRow,
  SlateSelectedSubagent,
  SlateSelectedTerminalOutput,
  SlateSelectedTerminalRange,
  SlateSelectedVideoState,
  SlateSelectedWorkspaceFile,
  SlateSelectedCommit,
  SlateSelectedConsoleLog,
  SlateSelectedDocumentationReference,
  SlateSelectedUIElement,
  SlateExternalResourceSelection,
  SlateInvocationEditorFile,
  SlateInvocationViewedChange,
  SlatePluginCapabilitySelection,
  SlateRecentAgentSelection,
  SlateRelatedConversation,
  SlateSelectedStackTrace,
  SlateSkillSelection,
  SlateWorkspaceRule,
  SlateWorkspaceRuleType,
} from "../../../packages/agent/context/selected-context-state.ts"

type InteropSelectedContext = InstanceType<typeof SelectedContext>

function selectedText(value: string | RedactedBytes | unknown): SlateContextText {
  return value as SlateContextText
}

function selectedBytes(value: unknown, label: string): SlateContextBytes {
  if (value instanceof RedactedBytes) return value.safeTransform(bytes => new Uint8Array(bytes))
  if (value instanceof Uint8Array) return new Uint8Array(value)
  throw new TypeError(`Selected-context ${label} must be bytes`)
}

function interopText(value: SlateContextText): never {
  return (value instanceof RedactedString
    ? value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    : value) as never
}

function interopBytes(value: SlateContextBytes): never {
  return (value instanceof RedactedBytes
    ? new Uint8Array(value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED))
    : new Uint8Array(value)) as never
}

function fromPosition(value: { readonly line?: number; readonly column?: number } | undefined): SlateSelectedPosition | undefined {
  return value === undefined ? undefined : { line: value.line ?? 0, column: value.column ?? 0 }
}

function toPosition(value: SlateSelectedPosition | undefined) {
  return value === undefined ? undefined : { line: value.line, column: value.column }
}

function fromRange(value: { readonly start?: { readonly line?: number; readonly column?: number }; readonly end?: { readonly line?: number; readonly column?: number } } | undefined): SlateSelectedRange | undefined {
  if (value === undefined) return undefined
  const start = fromPosition(value.start)
  const end = fromPosition(value.end)
  return { ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }) }
}

function toRange(value: SlateSelectedRange | undefined) {
  return value === undefined ? undefined : {
    ...(value.start === undefined ? {} : { start: toPosition(value.start) }),
    ...(value.end === undefined ? {} : { end: toPosition(value.end) }),
  }
}

function fromDirectoryTree(value: unknown): SlateSelectedDirectoryNode | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const node = value as Record<string, unknown>
  if (!Array.isArray(node.childrenDirs) || !Array.isArray(node.childrenFiles)) return undefined
  const directories = node.childrenDirs.map(fromDirectoryTree)
  if (directories.some(child => child === undefined)) return undefined
  const files = node.childrenFiles.map(fileValue => {
    if (fileValue === null || typeof fileValue !== "object" || Array.isArray(fileValue)) return undefined
    const file = fileValue as Record<string, unknown>
    const metadataValue = file.terminalMetadata
    let terminalMetadata: SlateSelectedDirectoryNode["files"][number]["terminalMetadata"]
    if (metadataValue !== undefined) {
      if (metadataValue === null || typeof metadataValue !== "object" || Array.isArray(metadataValue)) return undefined
      const metadata = metadataValue as Record<string, unknown>
      const command = (candidate: unknown) => {
        if (candidate === undefined) return undefined
        if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return undefined
        const item = candidate as Record<string, unknown>
        return {
          command: selectedText(item.command),
          ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode as number }),
          ...(item.timestampMs === undefined ? {} : { timestampMs: item.timestampMs as bigint }),
          ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs as bigint }),
        }
      }
      const lastCommands = Array.isArray(metadata.lastCommands) ? metadata.lastCommands.map(command) : []
      if (lastCommands.some(item => item === undefined)) return undefined
      const currentCommand = command(metadata.currentCommand)
      if (metadata.currentCommand !== undefined && currentCommand === undefined) return undefined
      terminalMetadata = {
        ...(metadata.cwd === undefined ? {} : { cwd: selectedText(metadata.cwd) }),
        ...(metadata.lastModifiedMs === undefined ? {} : { lastModifiedMs: metadata.lastModifiedMs as bigint }),
        lastCommands: lastCommands as NonNullable<NonNullable<typeof terminalMetadata>["lastCommands"]>,
        ...(currentCommand === undefined ? {} : { currentCommand }),
      }
    }
    return {
      name: selectedText(file.name),
      ...(terminalMetadata === undefined ? {} : { terminalMetadata }),
    }
  })
  if (files.some(file => file === undefined)) return undefined
  const countsValue = node.fullSubtreeExtensionCounts
  const extensionCounts: Record<string, number> = {}
  if (countsValue instanceof Map) {
    for (const [extension, count] of countsValue) extensionCounts[String(extension)] = Number(count)
  } else if (countsValue !== null && typeof countsValue === "object" && !Array.isArray(countsValue)) {
    for (const [extension, count] of Object.entries(countsValue)) extensionCounts[extension] = Number(count)
  }
  return {
    path: selectedText(node.absPath),
    processed: node.childrenWereProcessed === true,
    files: files as SlateSelectedDirectoryNode["files"],
    directories: directories as SlateSelectedDirectoryNode["directories"],
    fileCount: Number(node.numFiles ?? 0),
    extensionCounts,
  }
}

function toDirectoryTree(value: SlateSelectedDirectoryNode | undefined): unknown {
  if (value === undefined) return undefined
  return {
    absPath: interopText(value.path),
    childrenWereProcessed: value.processed,
    childrenFiles: value.files.map(file => ({
      name: interopText(file.name),
      ...(file.terminalMetadata === undefined ? {} : {
        terminalMetadata: {
          ...(file.terminalMetadata.cwd === undefined ? {} : { cwd: interopText(file.terminalMetadata.cwd) }),
          ...(file.terminalMetadata.lastModifiedMs === undefined ? {} : { lastModifiedMs: file.terminalMetadata.lastModifiedMs }),
          lastCommands: file.terminalMetadata.lastCommands?.map(command => ({
            command: interopText(command.command),
            ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }),
            ...(command.timestampMs === undefined ? {} : { timestampMs: command.timestampMs }),
            ...(command.durationMs === undefined ? {} : { durationMs: command.durationMs }),
          })) ?? [],
          ...(file.terminalMetadata.currentCommand === undefined ? {} : {
            currentCommand: {
              command: interopText(file.terminalMetadata.currentCommand.command),
              ...(file.terminalMetadata.currentCommand.exitCode === undefined ? {} : { exitCode: file.terminalMetadata.currentCommand.exitCode }),
              ...(file.terminalMetadata.currentCommand.timestampMs === undefined ? {} : { timestampMs: file.terminalMetadata.currentCommand.timestampMs }),
              ...(file.terminalMetadata.currentCommand.durationMs === undefined ? {} : { durationMs: file.terminalMetadata.currentCommand.durationMs }),
            },
          }),
        },
      }),
    })),
    childrenDirs: value.directories.map(child => toDirectoryTree(child)),
    numFiles: value.fileCount,
    fullSubtreeExtensionCounts: { ...value.extensionCounts },
  }
}

function fromImage(image: InteropSelectedContext["selectedImages"][number]): SlateSelectedImageState {
  const payload = image.dataOrBlobId
  let content: SlateSelectedImageState["content"]
  switch (payload?.case) {
    case "data": content = { kind: "inline", bytes: selectedBytes(payload.value, "image data") }; break
    case "blobId": content = { kind: "stored", blobId: selectedBytes(payload.value, "image blob id") }; break
    case "blobIdWithData":
      content = {
        kind: "stored-with-inline",
        blobId: selectedBytes(payload.value.blobId, "image blob id"),
        bytes: selectedBytes(payload.value.data, "image data"),
      }
      break
    case "promptUploadRef": content = { kind: "upload", uploadId: selectedText(payload.value.uploadId) }; break
    default: content = undefined
  }
  return {
    id: image.uuid,
    path: selectedText(image.path),
    mediaType: image.mimeType,
    ...(image.dimension === undefined ? {} : { dimensions: { width: image.dimension.width, height: image.dimension.height } }),
    ...(content === undefined ? {} : { content }),
  }
}

function toImage(image: SlateSelectedImageState) {
  let dataOrBlobId: unknown
  switch (image.content?.kind) {
    case "inline": dataOrBlobId = { case: "data", value: interopBytes(image.content.bytes) }; break
    case "stored": dataOrBlobId = { case: "blobId", value: interopBytes(image.content.blobId) }; break
    case "stored-with-inline":
      dataOrBlobId = {
        case: "blobIdWithData",
        value: { blobId: interopBytes(image.content.blobId), data: interopBytes(image.content.bytes) },
      }
      break
    case "upload": dataOrBlobId = { case: "promptUploadRef", value: { uploadId: interopText(image.content.uploadId) } }; break
    default: dataOrBlobId = { case: undefined, value: undefined }
  }
  return {
    uuid: image.id,
    path: interopText(image.path),
    mimeType: image.mediaType,
    ...(image.dimensions === undefined ? {} : { dimension: { ...image.dimensions } }),
    dataOrBlobId,
  }
}

function fromVideo(video: InteropSelectedContext["selectedVideos"][number]): SlateSelectedVideoState {
  const payload = video.dataOrBlobId
  let content: SlateSelectedVideoState["content"]
  switch (payload?.case) {
    case "data": content = { kind: "inline", bytes: selectedBytes(payload.value, "video data") }; break
    case "blobId": content = { kind: "stored", blobId: selectedBytes(payload.value, "video blob id") }; break
    case "blobIdWithData":
      content = {
        kind: "stored-with-inline",
        blobId: selectedBytes(payload.value.blobId, "video blob id"),
        bytes: selectedBytes(payload.value.data, "video data"),
      }
      break
    case "signedUrl":
      content = {
        kind: "signed-link",
        url: selectedText(payload.value.url),
        key: payload.value.key,
        expiresAtUnixMs: payload.value.expiresAtUnixMs,
        refreshAfterUnixMs: payload.value.refreshAfterUnixMs,
        conversationId: payload.value.conversationId,
      }
      break
    default: content = { kind: "empty" }
  }
  return {
    id: video.uuid,
    path: selectedText(video.path),
    displayName: selectedText(video.filename),
    mediaType: video.mimeType,
    ...(video.fps === undefined ? {} : { frameRate: video.fps }),
    writeToWorkspace: video.materializeToFilesystem,
    content,
  }
}

function toVideo(video: SlateSelectedVideoState) {
  let dataOrBlobId: unknown
  switch (video.content.kind) {
    case "inline": dataOrBlobId = { case: "data", value: interopBytes(video.content.bytes) }; break
    case "stored": dataOrBlobId = { case: "blobId", value: interopBytes(video.content.blobId) }; break
    case "stored-with-inline":
      dataOrBlobId = {
        case: "blobIdWithData",
        value: { blobId: interopBytes(video.content.blobId), data: interopBytes(video.content.bytes) },
      }
      break
    case "signed-link":
      dataOrBlobId = {
        case: "signedUrl",
        value: {
          url: interopText(video.content.url),
          key: video.content.key,
          expiresAtUnixMs: video.content.expiresAtUnixMs,
          refreshAfterUnixMs: video.content.refreshAfterUnixMs,
          conversationId: video.content.conversationId,
        },
      }
      break
    case "empty": dataOrBlobId = { case: undefined, value: undefined }; break
  }
  return {
    uuid: video.id,
    path: interopText(video.path),
    filename: interopText(video.displayName),
    mimeType: video.mediaType,
    ...(video.frameRate === undefined ? {} : { fps: video.frameRate }),
    materializeToFilesystem: video.writeToWorkspace,
    dataOrBlobId,
  }
}

function fromDocument(document: InteropSelectedContext["selectedDocuments"][number]): SlateSelectedDocumentState {
  const payload = document.dataOrBlobId
  let content: SlateSelectedDocumentState["content"]
  switch (payload?.case) {
    case "data": content = { kind: "inline", bytes: selectedBytes(payload.value, "document data") }; break
    case "blobId": content = { kind: "stored", blobId: selectedBytes(payload.value, "document blob id") }; break
    case "blobIdWithData":
      content = {
        kind: "stored-with-inline",
        blobId: selectedBytes(payload.value.blobId, "document blob id"),
        bytes: selectedBytes(payload.value.data, "document data"),
      }
      break
    case "promptUploadRef": content = { kind: "upload", uploadId: selectedText(payload.value.uploadId) }; break
    default: content = { kind: "empty" }
  }
  return {
    id: document.uuid,
    displayName: selectedText(document.filename),
    mediaType: document.mimeType,
    path: selectedText(document.path),
    content,
  }
}

function toDocument(document: SlateSelectedDocumentState) {
  let dataOrBlobId: unknown
  switch (document.content.kind) {
    case "inline": dataOrBlobId = { case: "data", value: interopBytes(document.content.bytes) }; break
    case "stored": dataOrBlobId = { case: "blobId", value: interopBytes(document.content.blobId) }; break
    case "stored-with-inline":
      dataOrBlobId = {
        case: "blobIdWithData",
        value: { blobId: interopBytes(document.content.blobId), data: interopBytes(document.content.bytes) },
      }
      break
    case "upload": dataOrBlobId = { case: "promptUploadRef", value: { uploadId: interopText(document.content.uploadId) } }; break
    case "empty": dataOrBlobId = { case: undefined, value: undefined }; break
  }
  return {
    uuid: document.id,
    filename: interopText(document.displayName),
    mimeType: document.mediaType,
    path: interopText(document.path),
    dataOrBlobId,
  }
}

function fromInvocation(value: InteropSelectedContext["invocationContext"]): SlateInvocationSelectionState | undefined {
  if (value === undefined) return undefined
  const data = value.data
  switch (data.case) {
    case "slackThread":
      return {
        kind: "conversation",
        context: {
          platform: "slack",
          body: selectedText(data.value.thread),
          ...(data.value.channelName === undefined && data.value.channelPurpose === undefined && data.value.channelTopic === undefined
            ? {}
            : { channel: {
                ...(data.value.channelName === undefined ? {} : { name: selectedText(data.value.channelName) }),
                ...(data.value.channelPurpose === undefined ? {} : { purpose: selectedText(data.value.channelPurpose) }),
                ...(data.value.channelTopic === undefined ? {} : { topic: selectedText(data.value.channelTopic) }),
              } }),
          ...(data.value.senderName === undefined && data.value.senderId === undefined && data.value.senderType === undefined
            ? {}
            : { sender: {
                ...(data.value.senderName === undefined ? {} : { name: selectedText(data.value.senderName) }),
                ...(data.value.senderId === undefined ? {} : { id: selectedText(data.value.senderId) }),
                ...(data.value.senderType === undefined ? {} : { kind: selectedText(data.value.senderType) }),
              } }),
          ...(data.value.isDirectlyAddressed === undefined ? {} : { directlyAddressed: data.value.isDirectlyAddressed }),
        },
      }
    case "microsoftTeamsThread":
      return {
        kind: "conversation",
        context: {
          platform: "microsoft-teams",
          body: selectedText(data.value.thread),
          channel: {
            ...(data.value.channelName === undefined ? {} : { name: selectedText(data.value.channelName) }),
            ...(data.value.teamName === undefined ? {} : { teamName: selectedText(data.value.teamName) }),
            ...(data.value.channelDescription === undefined ? {} : { description: selectedText(data.value.channelDescription) }),
            ...(data.value.teamDescription === undefined ? {} : { teamDescription: selectedText(data.value.teamDescription) }),
          },
        },
      }
    case "githubPr":
      return {
        kind: "change-review",
        title: selectedText(data.value.title),
        description: selectedText(data.value.description),
        comments: selectedText(data.value.comments),
        ...(data.value.ciFailures === undefined ? {} : { buildFailures: selectedText(data.value.ciFailures) }),
      }
    case "ideState":
      return {
        kind: "editor",
        state: {
          visibleFiles: data.value.visibleFiles.map(fromInvocationFile),
          recentlyViewedFiles: data.value.recentlyViewedFiles.map(fromInvocationFile),
          viewedChanges: data.value.currentlyViewedPrs.map((change): SlateInvocationViewedChange => ({
            number: change.number,
            url: selectedText(change.url),
            ...(change.title === undefined ? {} : { title: selectedText(change.title) }),
            ...(change.folderPath === undefined ? {} : { localDirectory: selectedText(change.folderPath) }),
            ...(change.summaryJson === undefined ? {} : { summaryDocument: selectedText(change.summaryJson) }),
            ...(change.description === undefined ? {} : { description: selectedText(change.description) }),
          })),
        },
      }
    case "blobId": return { kind: "stored", blobId: selectedBytes(data.value, "invocation blob id") }
    default: return { kind: "unsupported" }
  }
}

function fromInvocationFile(file: {
  readonly path: string
  readonly relativePath?: string
  readonly cursorPosition?: { readonly line: number; readonly text: string }
  readonly totalLines: number
  readonly activeCommand?: string
}): SlateInvocationEditorFile {
  const cursor = file.cursorPosition
  return {
    path: selectedText(file.path),
    ...(file.relativePath === undefined ? {} : { relativePath: selectedText(file.relativePath) }),
    ...(cursor === undefined ? {} : { cursor: { line: cursor.line, text: selectedText(cursor.text) } }),
    totalLines: file.totalLines,
    ...(file.activeCommand === undefined ? {} : { activeCommand: selectedText(file.activeCommand) }),
  }
}

function toInvocation(value: SlateInvocationSelectionState | undefined): unknown {
  if (value === undefined) return undefined
  switch (value.kind) {
    case "conversation": {
      const conversation = value.context
      if (conversation.platform === "slack") {
        return { data: { case: "slackThread", value: {
          thread: interopText(conversation.body),
          ...(conversation.channel?.name === undefined ? {} : { channelName: interopText(conversation.channel.name) }),
          ...(conversation.channel?.purpose === undefined ? {} : { channelPurpose: interopText(conversation.channel.purpose) }),
          ...(conversation.channel?.topic === undefined ? {} : { channelTopic: interopText(conversation.channel.topic) }),
          ...(conversation.sender?.name === undefined ? {} : { senderName: interopText(conversation.sender.name) }),
          ...(conversation.sender?.id === undefined ? {} : { senderId: interopText(conversation.sender.id) }),
          ...(conversation.sender?.kind === undefined ? {} : { senderType: interopText(conversation.sender.kind) }),
          ...(conversation.directlyAddressed === undefined ? {} : { isDirectlyAddressed: conversation.directlyAddressed }),
        } } }
      }
      return { data: { case: "microsoftTeamsThread", value: {
        thread: interopText(conversation.body),
        ...(conversation.channel?.name === undefined ? {} : { channelName: interopText(conversation.channel.name) }),
        ...(conversation.channel?.teamName === undefined ? {} : { teamName: interopText(conversation.channel.teamName) }),
        ...(conversation.channel?.description === undefined ? {} : { channelDescription: interopText(conversation.channel.description) }),
        ...(conversation.channel?.teamDescription === undefined ? {} : { teamDescription: interopText(conversation.channel.teamDescription) }),
      } } }
    }
    case "change-review":
      return { data: { case: "githubPr", value: {
        title: interopText(value.title),
        description: interopText(value.description),
        comments: interopText(value.comments),
        ...(value.buildFailures === undefined ? {} : { ciFailures: interopText(value.buildFailures) }),
      } } }
    case "editor":
      return { data: { case: "ideState", value: {
        visibleFiles: value.state.visibleFiles.map(toInvocationFile),
        recentlyViewedFiles: value.state.recentlyViewedFiles.map(toInvocationFile),
        currentlyViewedPrs: value.state.viewedChanges.map(change => ({
          number: change.number,
          url: interopText(change.url),
          ...(change.title === undefined ? {} : { title: interopText(change.title) }),
          ...(change.localDirectory === undefined ? {} : { folderPath: interopText(change.localDirectory) }),
          ...(change.summaryDocument === undefined ? {} : { summaryJson: interopText(change.summaryDocument) }),
          ...(change.description === undefined ? {} : { description: interopText(change.description) }),
        })),
      } } }
    case "stored": return { data: { case: "blobId", value: interopBytes(value.blobId) } }
    case "unsupported": return { data: { case: undefined, value: undefined } }
  }
}

function toInvocationFile(file: SlateInvocationEditorFile) {
  return {
    path: interopText(file.path),
    ...(file.relativePath === undefined ? {} : { relativePath: interopText(file.relativePath) }),
    ...(file.cursor === undefined ? {} : { cursorPosition: { line: file.cursor.line, text: interopText(file.cursor.text) } }),
    totalLines: file.totalLines,
    ...(file.activeCommand === undefined ? {} : { activeCommand: interopText(file.activeCommand) }),
  }
}

function fromRuleType(value: NonNullable<NonNullable<InteropSelectedContext["cursorRules"][number]["rule"]>["type"]>): SlateWorkspaceRuleType | undefined {
  switch (value.type.case) {
    case "global": return { kind: "global" }
    case "fileGlobbed": return { kind: "file-patterns", patterns: [...value.type.value.globs] }
    case "agentFetched": return { kind: "suggested", description: selectedText(value.type.value.description) }
    case "manuallyAttached": return { kind: "manual" }
    default: return undefined
  }
}

function fromRule(rule: NonNullable<InteropSelectedContext["cursorRules"][number]["rule"]>): SlateWorkspaceRule {
  const source = rule.source === CursorRuleSource.TEAM
    ? "team"
    : rule.source === CursorRuleSource.USER
      ? "user"
      : rule.source === CursorRuleSource.UNSPECIFIED
        ? "unspecified"
        : `unknown-${rule.source}` as const
  const type = rule.type === undefined ? undefined : fromRuleType(rule.type)
  return {
    path: selectedText(rule.fullPath),
    content: selectedText(rule.content),
    ...(type === undefined ? {} : { type }),
    source,
    ...(rule.gitRemoteOrigin === undefined ? {} : { remoteOrigin: selectedText(rule.gitRemoteOrigin) }),
    ...(rule.parseError === undefined ? {} : { parseError: selectedText(rule.parseError) }),
    environments: [...rule.environments],
    disabledEnvironments: [...rule.disabledEnvironments],
    ...(rule.plugin === undefined ? {} : { pluginName: selectedText(rule.plugin) }),
    ...(rule.marketplace === undefined ? {} : { marketplaceName: selectedText(rule.marketplace) }),
    ...(rule.pluginId === undefined ? {} : { pluginId: selectedText(rule.pluginId) }),
    ...(rule.marketplaceId === undefined ? {} : { marketplaceId: selectedText(rule.marketplaceId) }),
    scopedTo: [...rule.scopedTo],
    frontmatter: selectedText(rule.frontmatter),
    ...(rule.isRequired === undefined ? {} : { required: rule.isRequired }),
  }
}

function toRuleType(value: SlateWorkspaceRuleType | undefined): unknown {
  if (value === undefined) return undefined
  switch (value.kind) {
    case "global": return { type: { case: "global", value: {} } }
    case "file-patterns": return { type: { case: "fileGlobbed", value: { globs: [...value.patterns] } } }
    case "suggested": return { type: { case: "agentFetched", value: { description: interopText(value.description) } } }
    case "manual": return { type: { case: "manuallyAttached", value: {} } }
    case "unknown": return undefined
  }
}

function toRule(rule: SlateWorkspaceRule) {
  const source = rule.source === "team"
    ? CursorRuleSource.TEAM
    : rule.source === "user"
      ? CursorRuleSource.USER
      : rule.source === "unspecified"
        ? CursorRuleSource.UNSPECIFIED
        : Number(/^unknown-(-?\d+)$/.exec(rule.source)?.[1] ?? 0) as CursorRuleSource
  return {
    fullPath: interopText(rule.path),
    content: interopText(rule.content),
    ...(rule.type === undefined ? {} : { type: toRuleType(rule.type) }),
    source,
    ...(rule.remoteOrigin === undefined ? {} : { gitRemoteOrigin: interopText(rule.remoteOrigin) }),
    ...(rule.parseError === undefined ? {} : { parseError: interopText(rule.parseError) }),
    environments: [...rule.environments],
    disabledEnvironments: [...rule.disabledEnvironments],
    ...(rule.pluginName === undefined ? {} : { plugin: interopText(rule.pluginName) }),
    ...(rule.marketplaceName === undefined ? {} : { marketplace: interopText(rule.marketplaceName) }),
    ...(rule.pluginId === undefined ? {} : { pluginId: interopText(rule.pluginId) }),
    ...(rule.marketplaceId === undefined ? {} : { marketplaceId: interopText(rule.marketplaceId) }),
    scopedTo: [...rule.scopedTo],
    frontmatter: interopText(rule.frontmatter),
    ...(rule.required === undefined ? {} : { isRequired: rule.required }),
  }
}

function capabilityFromInterop(value: SelectedPluginCapabilityType): SlatePluginCapabilitySelection["capability"] {
  if (value === SelectedPluginCapabilityType.COMMAND) return "command"
  if (value === SelectedPluginCapabilityType.SKILL) return "skill"
  if (value === SelectedPluginCapabilityType.SUBAGENT) return "subagent"
  if (value === SelectedPluginCapabilityType.UNSPECIFIED) return "unspecified"
  return `unknown-${value}`
}

function capabilityToInterop(value: SlatePluginCapabilitySelection["capability"]): SelectedPluginCapabilityType {
  if (value === "command") return SelectedPluginCapabilityType.COMMAND
  if (value === "skill") return SelectedPluginCapabilityType.SKILL
  if (value === "subagent") return SelectedPluginCapabilityType.SUBAGENT
  if (value === "unspecified") return SelectedPluginCapabilityType.UNSPECIFIED
  return Number(/^unknown-(-?\d+)$/.exec(value)?.[1] ?? 0) as SelectedPluginCapabilityType
}

function fromCommand(command: InteropSelectedContext["cursorCommands"][number]) {
  const capability = command.pluginCapability
  return {
    name: command.name,
    content: selectedText(command.content),
    ...(command.fullPath === undefined ? {} : { sourcePath: selectedText(command.fullPath) }),
    ...(command.displayName === undefined ? {} : { displayName: selectedText(command.displayName) }),
    ...(capability === undefined ? {} : { capability: {
      pluginId: capability.pluginId,
      capability: capabilityFromInterop(capability.capabilityType),
      sourcePath: selectedText(capability.sourcePath),
      snapshotToken: selectedText(capability.snapshotToken),
      ...(capability.resolvedCommitSha === undefined ? {} : { resolvedCommit: capability.resolvedCommitSha }),
    } }),
  }
}

function toCommand(command: SlateSelectedContextState["commands"][number]) {
  return {
    name: command.name,
    content: interopText(command.content),
    ...(command.sourcePath === undefined ? {} : { fullPath: interopText(command.sourcePath) }),
    ...(command.displayName === undefined ? {} : { displayName: interopText(command.displayName) }),
    ...(command.capability === undefined ? {} : { pluginCapability: {
      pluginId: command.capability.pluginId,
      capabilityType: capabilityToInterop(command.capability.capability),
      sourcePath: interopText(command.capability.sourcePath),
      snapshotToken: interopText(command.capability.snapshotToken),
      ...(command.capability.resolvedCommit === undefined ? {} : { resolvedCommitSha: command.capability.resolvedCommit }),
    } }),
  }
}

function fromSkill(skill: InteropSelectedContext["selectedSkills"][number]): SlateSkillSelection {
  return {
    path: selectedText(skill.fullPath),
    content: selectedText(skill.content),
    description: selectedText(skill.description),
    ...(skill.parseError === undefined ? {} : { parseError: selectedText(skill.parseError) }),
    environments: [...skill.environments],
    disabledEnvironments: [...skill.disabledEnvironments],
    ...(skill.gitRemoteOrigin === undefined ? {} : { remoteOrigin: selectedText(skill.gitRemoteOrigin) }),
    modelInvocationDisabled: skill.disableModelInvocation,
    ...(skill.plugin === undefined ? {} : { pluginName: selectedText(skill.plugin) }),
    ...(skill.marketplace === undefined ? {} : { marketplaceName: selectedText(skill.marketplace) }),
    ...(skill.pluginId === undefined ? {} : { pluginId: selectedText(skill.pluginId) }),
    ...(skill.marketplaceId === undefined ? {} : { marketplaceId: selectedText(skill.marketplaceId) }),
    filePatterns: [...skill.globs],
    scopedTo: [...skill.scopedTo],
  }
}

function toSkill(skill: SlateSkillSelection) {
  return {
    fullPath: interopText(skill.path),
    content: interopText(skill.content),
    description: interopText(skill.description),
    ...(skill.parseError === undefined ? {} : { parseError: interopText(skill.parseError) }),
    environments: [...skill.environments],
    disabledEnvironments: [...skill.disabledEnvironments],
    ...(skill.remoteOrigin === undefined ? {} : { gitRemoteOrigin: interopText(skill.remoteOrigin) }),
    disableModelInvocation: skill.modelInvocationDisabled,
    ...(skill.pluginName === undefined ? {} : { plugin: interopText(skill.pluginName) }),
    ...(skill.marketplaceName === undefined ? {} : { marketplace: interopText(skill.marketplaceName) }),
    ...(skill.pluginId === undefined ? {} : { pluginId: interopText(skill.pluginId) }),
    ...(skill.marketplaceId === undefined ? {} : { marketplaceId: interopText(skill.marketplaceId) }),
    globs: [...skill.filePatterns],
    scopedTo: [...skill.scopedTo],
  }
}

function fromActionCommit(params: SelectedAgenticGitActionCommitParams): SlateRepositoryCommitIntent {
  return {
    files: params.filesToCommit.map(value => selectedText(value)),
    excludedFiles: params.filesToExcludeFromCommit.map(value => selectedText(value)),
    stageAllChanges: params.shouldStageAllChanges,
    ...(params.createPrDraft === undefined ? {} : { draftPullRequest: params.createPrDraft }),
    filesWithStatus: params.filesToCommitWithStatus.map(file => ({
      path: selectedText(file.path),
      ...(file.status === undefined ? {} : { status: selectedText(file.status) }),
    })),
    excludedFilesWithStatus: params.filesToExcludeFromCommitWithStatus.map(file => ({
      path: selectedText(file.path),
      ...(file.status === undefined ? {} : { status: selectedText(file.status) }),
    })),
  }
}

function toActionCommit(commit: SlateRepositoryCommitIntent) {
  return {
    filesToCommit: commit.files.map(interopText),
    filesToExcludeFromCommit: commit.excludedFiles.map(interopText),
    shouldStageAllChanges: commit.stageAllChanges,
    ...(commit.draftPullRequest === undefined ? {} : { createPrDraft: commit.draftPullRequest }),
    filesToCommitWithStatus: commit.filesWithStatus.map(file => ({ path: interopText(file.path), ...(file.status === undefined ? {} : { status: interopText(file.status) }) })),
    filesToExcludeFromCommitWithStatus: commit.excludedFilesWithStatus.map(file => ({ path: interopText(file.path), ...(file.status === undefined ? {} : { status: interopText(file.status) }) })),
  }
}

function fromAction(value: SelectedAgenticGitAction | undefined): SlateRepositoryActionSelection | undefined {
  if (value === undefined) return undefined
  const branch = value.branchContext
  const branchContext = branch === undefined ? undefined : {
    ...(branch.currentBranch === undefined ? {} : { currentBranch: selectedText(branch.currentBranch) }),
    ...(branch.baseBranch === undefined ? {} : { baseBranch: selectedText(branch.baseBranch) }),
    ...(branch.agentBranchPrefix === undefined ? {} : { agentBranchPrefix: selectedText(branch.agentBranchPrefix) }),
  }
  let parameters: SlateRepositoryActionParameters | undefined
  switch (value.params.case) {
    case "commitParams": parameters = { kind: "commit", commit: fromActionCommit(value.params.value) }; break
    case "pushParams": parameters = { kind: "push", files: value.params.value.filesToPush.map(selectedText), ...(value.params.value.createPrDraft === undefined ? {} : { draftPullRequest: value.params.value.createPrDraft }) }; break
    case "fixMergeConflictsParams": parameters = { kind: "fix-merge-conflicts", ...(value.params.value.baseBranch === undefined ? {} : { baseBranch: selectedText(value.params.value.baseBranch) }), ...(value.params.value.prUrl === undefined ? {} : { pullRequestUrl: selectedText(value.params.value.prUrl) }) }; break
    case "commitAndPushParams": parameters = { kind: "commit-and-push", commit: fromActionCommit(value.params.value) }; break
    case "createPrParams": parameters = { kind: "create-pull-request", ...(value.params.value.createPrDraft === undefined ? {} : { draft: value.params.value.createPrDraft }) }; break
    case "createPrWithChangesParams": parameters = { kind: "create-pull-request-with-changes", commit: fromActionCommit(value.params.value) }; break
    case "babysitPrInCloudParams": parameters = { kind: "babysit-pull-request", ...(value.params.value.baseBranch === undefined ? {} : { baseBranch: selectedText(value.params.value.baseBranch) }) }; break
    case "createBranchAndCommitParams": parameters = { kind: "create-branch-and-commit", commit: fromActionCommit(value.params.value) }; break
    case "createBranchCommitAndPushParams": parameters = { kind: "create-branch-commit-and-push", commit: fromActionCommit(value.params.value) }; break
    case "applyLocallyParams": parameters = { kind: "apply-locally", remoteBranch: selectedText(value.params.value.remoteBranch) }; break
    case "checkoutBranchParams": parameters = { kind: "checkout-branch", remoteBranch: selectedText(value.params.value.remoteBranch) }; break
    case "updateBranchParams": parameters = { kind: "update-branch", ...(value.params.value.baseBranch === undefined ? {} : { baseBranch: selectedText(value.params.value.baseBranch) }) }; break
    case "createBranchParams": parameters = { kind: "create-branch" }; break
    default: parameters = undefined
  }
  return {
    ...(parameters === undefined ? {} : { parameters }),
    ...(branchContext === undefined ? {} : { branch: branchContext }),
    ...(value.pathToTemplateFile === undefined ? {} : { templateFilePath: selectedText(value.pathToTemplateFile) }),
    ...(value.pathToTemplateDir === undefined ? {} : { templateDirectoryPath: selectedText(value.pathToTemplateDir) }),
  }
}

function toAction(action: SlateRepositoryActionSelection | undefined): unknown {
  if (action === undefined) return undefined
  const branchContext = action.branch === undefined ? undefined : {
    ...(action.branch.currentBranch === undefined ? {} : { currentBranch: interopText(action.branch.currentBranch) }),
    ...(action.branch.baseBranch === undefined ? {} : { baseBranch: interopText(action.branch.baseBranch) }),
    ...(action.branch.agentBranchPrefix === undefined ? {} : { agentBranchPrefix: interopText(action.branch.agentBranchPrefix) }),
  }
  let params: { case: string; value: unknown } | undefined
  const input = action.parameters
  switch (input?.kind) {
    case undefined: break
    case "commit": params = { case: "commitParams", value: toActionCommit(input.commit) }; break
    case "push": params = { case: "pushParams", value: { filesToPush: input.files.map(interopText), ...(input.draftPullRequest === undefined ? {} : { createPrDraft: input.draftPullRequest }) } }; break
    case "fix-merge-conflicts": params = { case: "fixMergeConflictsParams", value: { ...(input.baseBranch === undefined ? {} : { baseBranch: interopText(input.baseBranch) }), ...(input.pullRequestUrl === undefined ? {} : { prUrl: interopText(input.pullRequestUrl) }) } }; break
    case "commit-and-push": params = { case: "commitAndPushParams", value: toActionCommit(input.commit) }; break
    case "create-pull-request": params = { case: "createPrParams", value: { ...(input.draft === undefined ? {} : { createPrDraft: input.draft }) } }; break
    case "create-pull-request-with-changes": params = { case: "createPrWithChangesParams", value: toActionCommit(input.commit) }; break
    case "babysit-pull-request": params = { case: "babysitPrInCloudParams", value: { ...(input.baseBranch === undefined ? {} : { baseBranch: interopText(input.baseBranch) }) } }; break
    case "create-branch-and-commit": params = { case: "createBranchAndCommitParams", value: toActionCommit(input.commit) }; break
    case "create-branch-commit-and-push": params = { case: "createBranchCommitAndPushParams", value: toActionCommit(input.commit) }; break
    case "apply-locally": params = { case: "applyLocallyParams", value: { remoteBranch: interopText(input.remoteBranch) } }; break
    case "checkout-branch": params = { case: "checkoutBranchParams", value: { remoteBranch: interopText(input.remoteBranch) } }; break
    case "update-branch": params = { case: "updateBranchParams", value: { ...(input.baseBranch === undefined ? {} : { baseBranch: interopText(input.baseBranch) }) } }; break
    case "create-branch": params = { case: "createBranchParams", value: {} }; break
  }
  return {
    ...(branchContext === undefined ? {} : { branchContext }),
    ...(action.templateFilePath === undefined ? {} : { pathToTemplateFile: interopText(action.templateFilePath) }),
    ...(action.templateDirectoryPath === undefined ? {} : { pathToTemplateDir: interopText(action.templateDirectoryPath) }),
    params: params ?? { case: undefined, value: undefined },
  }
}

/** Converts every known selection category into the Slate-owned source schema. */
export function fromInteropSelectedContextState(source: InteropSelectedContext): SlateSelectedContextState {
  const invocation = fromInvocation(source.invocationContext)
  const repositoryAction = fromAction(source.selectedAgenticGitAction)
  return {
    schema: "slate.selected-context",
    version: 1,
    media: {
      images: source.selectedImages.map(fromImage),
      videos: source.selectedVideos.map(fromVideo),
      documents: source.selectedDocuments.map(fromDocument),
    },
    ...(invocation === undefined ? {} : { invocation }),
    additionalText: source.extraContext.map(selectedText),
    workspace: {
      files: source.files.map(file => ({ path: selectedText(file.path), ...(file.relativePath === undefined ? {} : { relativePath: selectedText(file.relativePath) }), content: selectedText(file.content) })),
      codeSelections: source.codeSelections.map((selection): SlateSelectedCodeRange => {
        const range = fromRange(selection.range)
        return { path: selectedText(selection.path), ...(selection.relativePath === undefined ? {} : { relativePath: selectedText(selection.relativePath) }), content: selectedText(selection.content), ...(range === undefined ? {} : { range }) }
      }),
      terminalOutputs: source.terminals.map((terminal): SlateSelectedTerminalOutput => ({ content: selectedText(terminal.content), ...(terminal.title === undefined ? {} : { title: selectedText(terminal.title) }), ...(terminal.path === undefined ? {} : { path: selectedText(terminal.path) }) })),
      terminalRanges: source.terminalSelections.map((selection): SlateSelectedTerminalRange => {
        const range = fromRange(selection.range)
        return { content: selectedText(selection.content), ...(selection.title === undefined ? {} : { title: selectedText(selection.title) }), ...(selection.path === undefined ? {} : { path: selectedText(selection.path) }), ...(range === undefined ? {} : { range }) }
      }),
      folders: source.folders.map((folder): SlateSelectedFolderState => {
        const tree = fromDirectoryTree(folder.directoryTree)
        return { path: selectedText(folder.path), ...(folder.relativePath === undefined ? {} : { relativePath: selectedText(folder.relativePath) }), ...(tree === undefined ? {} : { tree }) }
      }),
    },
    externalResources: source.externalLinks.map((link): SlateExternalResourceSelection => ({
      id: link.uuid,
      url: selectedText(link.url),
      ...(link.pdfContent === undefined ? {} : { pdfText: selectedText(link.pdfContent) }),
      ...(link.isPdf === undefined ? {} : { isPdf: link.isPdf }),
      ...(link.filename === undefined ? {} : { displayName: selectedText(link.filename) }),
      ...(link.blobId === undefined ? {} : { blobId: selectedBytes(link.blobId, "external-resource blob id") }),
    })),
    rules: source.cursorRules.map((row): SlateSelectedRuleRow => row.rule === undefined ? {} : { rule: fromRule(row.rule) }),
    ...(source.gitDiffFromBranchToMain === undefined ? {} : { branchDiff: { content: selectedText(source.gitDiffFromBranchToMain.content), fullContentLength: source.gitDiffFromBranchToMain.fullContentLengthCharCount } }),
    commands: source.cursorCommands.map(fromCommand),
    documentation: source.documentations.map((item): SlateSelectedDocumentationReference => ({ id: selectedText(item.docId), displayName: selectedText(item.name) })),
    uiElements: source.uiElements.map((item): SlateSelectedUIElement => ({ element: selectedText(item.element), xpath: selectedText(item.xpath), textContent: selectedText(item.textContent), additionalContext: selectedText(item.extra), ...(item.component === undefined ? {} : { component: selectedText(item.component) }), ...(item.componentPropsJson === undefined ? {} : { componentPropsJson: selectedText(item.componentPropsJson) }) })),
    consoleLogs: source.consoleLogs.map((log): SlateSelectedConsoleLog => ({
      message: selectedText(log.message), timestamp: log.timestamp, level: log.level,
      clientName: selectedText(log.clientName), sessionId: selectedText(log.sessionId),
      ...(log.stackTrace === undefined ? {} : { stackTrace: {
        frames: log.stackTrace.callFrames.map(frame => ({ ...(frame.functionName === undefined ? {} : { functionName: selectedText(frame.functionName) }), ...(frame.url === undefined ? {} : { url: selectedText(frame.url) }), ...(frame.lineNumber === undefined ? {} : { line: frame.lineNumber }), ...(frame.columnNumber === undefined ? {} : { column: frame.columnNumber }) })),
        ...(log.stackTrace.rawStackTrace === undefined ? {} : { rawText: selectedText(log.stackTrace.rawStackTrace) }),
      } }),
      ...(log.objectDataJson === undefined ? {} : { objectDataJson: selectedText(log.objectDataJson) }),
    })),
    extraEntries: source.extraContextEntries.map((entry): SlateSelectedExtraContextEntry => {
      switch (entry.dataOrBlobId.case) {
        case "data": return { kind: "inline-text", text: selectedText(entry.dataOrBlobId.value) }
        case "blobId": return { kind: "stored-text", blobId: selectedBytes(entry.dataOrBlobId.value, "extra-context blob id") }
        default: return { kind: "empty" }
      }
    }),
    commits: source.gitCommits.map((commit): SlateSelectedCommit => ({ objectId: selectedText(commit.sha), subject: selectedText(commit.message), ...(commit.description === undefined ? {} : { explanation: selectedText(commit.description) }), patch: selectedText(commit.diff) })),
    ...(source.gitDiff === undefined ? {} : { workingTreeDiff: { content: selectedText(source.gitDiff.content), fullContentLength: source.gitDiff.fullContentLengthCharCount } }),
    relatedConversations: source.pastChats.map((chat): SlateRelatedConversation => ({ id: selectedText(chat.agentId), name: selectedText(chat.name) })),
    pullRequestDiffs: source.gitPrDiffSelections.map((diff): SlateSelectedPullRequestDiff => ({ url: selectedText(diff.prUrl), filePath: selectedText(diff.filePath), startLine: diff.startLine, endLine: diff.endLine, ...(diff.diffContent === undefined ? {} : { diff: selectedText(diff.diffContent) }), ...(diff.blobId === undefined ? {} : { blobId: selectedBytes(diff.blobId, "pull-request diff blob id") }) })),
    pullRequests: source.selectedPullRequests.map((pr): SlateSelectedPullRequest => ({ number: pr.number, url: selectedText(pr.url), ...(pr.title === undefined ? {} : { title: selectedText(pr.title) }), localDirectory: selectedText(pr.folderPath), ...(pr.summaryJson === undefined ? {} : { summaryDocument: selectedText(pr.summaryJson) }), ...(pr.description === undefined ? {} : { description: selectedText(pr.description) }), ...(pr.blobId === undefined ? {} : { blobId: selectedBytes(pr.blobId, "pull-request blob id") }) })),
    subagents: source.selectedSubagents.map((item): SlateSelectedSubagent => ({ name: selectedText(item.name) })),
    browserTabs: source.selectedBrowsers.map((tab): SlateBrowserTabSelection => ({ id: selectedText(tab.browserId), url: selectedText(tab.url), ...(tab.pageTitle === undefined ? {} : { title: selectedText(tab.pageTitle) }) })),
    skills: source.selectedSkills.map(fromSkill),
    ...(source.recentAgentsContext === undefined ? {} : { recentAgents: source.recentAgentsContext.recentAgents.map((agent): SlateRecentAgentSelection => ({ name: selectedText(agent.name), path: selectedText(agent.path), ...(agent.overview === undefined ? {} : { overview: selectedText(agent.overview) }) })) }),
    ...(repositoryAction === undefined ? {} : { repositoryAction }),
  }
}

/** Reconstructs the old wire message only for a legacy reader or an external adapter. */
export function toInteropSelectedContextState(state: SlateSelectedContextState): InteropSelectedContext {
  const action = toAction(state.repositoryAction)
  const invocationContext = toInvocation(state.invocation)
  return new SelectedContext({
    selectedImages: state.media.images.map(toImage),
    ...(invocationContext === undefined ? {} : { invocationContext }),
    extraContext: state.additionalText.map(interopText),
    files: state.workspace.files.map(file => ({ path: interopText(file.path), content: interopText(file.content), ...(file.relativePath === undefined ? {} : { relativePath: interopText(file.relativePath) }) })),
    codeSelections: state.workspace.codeSelections.map(selection => ({ content: interopText(selection.content), path: interopText(selection.path), ...(selection.relativePath === undefined ? {} : { relativePath: interopText(selection.relativePath) }), ...(selection.range === undefined ? {} : { range: toRange(selection.range) }) })),
    terminals: state.workspace.terminalOutputs.map(terminal => ({ content: interopText(terminal.content), ...(terminal.title === undefined ? {} : { title: interopText(terminal.title) }), ...(terminal.path === undefined ? {} : { path: interopText(terminal.path) }) })),
    terminalSelections: state.workspace.terminalRanges.map(selection => ({ content: interopText(selection.content), ...(selection.title === undefined ? {} : { title: interopText(selection.title) }), ...(selection.path === undefined ? {} : { path: interopText(selection.path) }), ...(selection.range === undefined ? {} : { range: toRange(selection.range) }) })),
    folders: state.workspace.folders.map(folder => ({ path: interopText(folder.path), ...(folder.relativePath === undefined ? {} : { relativePath: interopText(folder.relativePath) }), ...(folder.tree === undefined ? {} : { directoryTree: toDirectoryTree(folder.tree) }) })),
    externalLinks: state.externalResources.map(link => ({ url: interopText(link.url), uuid: link.id, ...(link.pdfText === undefined ? {} : { pdfContent: interopText(link.pdfText) }), ...(link.isPdf === undefined ? {} : { isPdf: link.isPdf }), ...(link.displayName === undefined ? {} : { filename: interopText(link.displayName) }), ...(link.blobId === undefined ? {} : { blobId: interopBytes(link.blobId) }) })),
    cursorRules: state.rules.map(row => ({ ...(row.rule === undefined ? {} : { rule: toRule(row.rule) }) })),
    ...(state.branchDiff === undefined ? {} : { gitDiffFromBranchToMain: { content: interopText(state.branchDiff.content), fullContentLengthCharCount: state.branchDiff.fullContentLength } }),
    cursorCommands: state.commands.map(toCommand),
    documentations: state.documentation.map(item => ({ docId: interopText(item.id), name: interopText(item.displayName) })),
    uiElements: state.uiElements.map(item => ({ element: interopText(item.element), xpath: interopText(item.xpath), textContent: interopText(item.textContent), extra: interopText(item.additionalContext), ...(item.component === undefined ? {} : { component: interopText(item.component) }), ...(item.componentPropsJson === undefined ? {} : { componentPropsJson: interopText(item.componentPropsJson) }) })),
    consoleLogs: state.consoleLogs.map(log => ({
      message: interopText(log.message), timestamp: log.timestamp, level: log.level, clientName: interopText(log.clientName), sessionId: interopText(log.sessionId),
      ...(log.stackTrace === undefined ? {} : { stackTrace: { callFrames: log.stackTrace.frames.map(frame => ({ ...(frame.functionName === undefined ? {} : { functionName: interopText(frame.functionName) }), ...(frame.url === undefined ? {} : { url: interopText(frame.url) }), ...(frame.line === undefined ? {} : { lineNumber: frame.line }), ...(frame.column === undefined ? {} : { columnNumber: frame.column }) })), ...(log.stackTrace.rawText === undefined ? {} : { rawStackTrace: interopText(log.stackTrace.rawText) }) } }),
      ...(log.objectDataJson === undefined ? {} : { objectDataJson: interopText(log.objectDataJson) }),
    })),
    extraContextEntries: state.extraEntries.map(entry => {
      switch (entry.kind) {
        case "inline-text": return { dataOrBlobId: { case: "data", value: interopText(entry.text) } }
        case "stored-text": return { dataOrBlobId: { case: "blobId", value: interopBytes(entry.blobId) } }
        case "empty": return { dataOrBlobId: { case: undefined, value: undefined } }
      }
    }),
    gitCommits: state.commits.map(commit => ({ sha: interopText(commit.objectId), message: interopText(commit.subject), ...(commit.explanation === undefined ? {} : { description: interopText(commit.explanation) }), diff: interopText(commit.patch) })),
    ...(state.workingTreeDiff === undefined ? {} : { gitDiff: { content: interopText(state.workingTreeDiff.content), fullContentLengthCharCount: state.workingTreeDiff.fullContentLength } }),
    pastChats: state.relatedConversations.map(chat => ({ agentId: interopText(chat.id), name: interopText(chat.name) })),
    gitPrDiffSelections: state.pullRequestDiffs.map(diff => ({ prUrl: interopText(diff.url), filePath: interopText(diff.filePath), startLine: diff.startLine, endLine: diff.endLine, ...(diff.diff === undefined ? {} : { diffContent: interopText(diff.diff) }), ...(diff.blobId === undefined ? {} : { blobId: interopBytes(diff.blobId) }) })),
    selectedPullRequests: state.pullRequests.map(pr => ({ number: pr.number, url: interopText(pr.url), ...(pr.title === undefined ? {} : { title: interopText(pr.title) }), folderPath: interopText(pr.localDirectory), ...(pr.summaryDocument === undefined ? {} : { summaryJson: interopText(pr.summaryDocument) }), ...(pr.description === undefined ? {} : { description: interopText(pr.description) }), ...(pr.blobId === undefined ? {} : { blobId: interopBytes(pr.blobId) }) })),
    selectedSubagents: state.subagents.map(item => ({ name: interopText(item.name) })),
    selectedVideos: state.media.videos.map(toVideo),
    selectedBrowsers: state.browserTabs.map(tab => ({ browserId: interopText(tab.id), url: interopText(tab.url), ...(tab.title === undefined ? {} : { pageTitle: interopText(tab.title) }) })),
    selectedDocuments: state.media.documents.map(toDocument),
    selectedSkills: state.skills.map(toSkill),
    ...(state.recentAgents === undefined ? {} : { recentAgentsContext: { recentAgents: state.recentAgents.map(agent => ({ name: interopText(agent.name), path: interopText(agent.path), ...(agent.overview === undefined ? {} : { overview: interopText(agent.overview) }) })) } }),
    ...(action === undefined ? {} : { selectedAgenticGitAction: action }),
  } as never)
}
