import type { InvocationContext } from "../proto/generated/agent/v1/selected_context_pb.ts"
import {
  renderInvocationPlatformContext,
  type InvocationEditorFile,
  type InvocationEditorState,
  type InvocationThread,
  type InvocationThreadChannel,
  type InvocationThreadSender,
  type InvocationViewedPullRequest,
  type SlateInvocationContext,
} from "../../../packages/agent/context/invocation-platforms.ts"
import type { PullRequestInvocationContext } from "../../../packages/agent/context/pull-request-invocation-context.ts"

function threadChannel(input: {
  readonly workspaceName?: string | undefined
  readonly workspaceDescription?: string | undefined
  readonly channelName?: string | undefined
  readonly channelDescription?: string | undefined
  readonly purpose?: string | undefined
  readonly topic?: string | undefined
}): InvocationThreadChannel {
  return {
    workspaceName: input.workspaceName,
    workspaceDescription: input.workspaceDescription,
    channelName: input.channelName,
    channelDescription: input.channelDescription,
    purpose: input.purpose,
    topic: input.topic,
  }
}

function sender(input: {
  readonly name?: string | undefined
  readonly id?: string | undefined
  readonly kind?: string | undefined
}): InvocationThreadSender {
  return { name: input.name, id: input.id, kind: input.kind }
}

function editorFile(input: {
  readonly path: string
  readonly totalLines?: number | undefined
  readonly activeCommand?: string | undefined
  readonly cursorPosition?: { readonly line: number } | undefined
}): InvocationEditorFile {
  return {
    path: input.path,
    totalLines: input.totalLines,
    activeCommand: input.activeCommand,
    ...(input.cursorPosition === undefined ? {} : { cursorLine: input.cursorPosition.line }),
  }
}

function viewedPullRequest(input: {
  readonly number: number
  readonly title?: string | undefined
  readonly url?: string | undefined
  readonly description?: string | undefined
  readonly folderPath?: string | undefined
  readonly summaryJson?: string | undefined
}): InvocationViewedPullRequest {
  return {
    number: input.number,
    title: input.title,
    url: input.url,
    description: input.description,
    folderPath: input.folderPath,
    summaryJson: input.summaryJson,
  }
}

function editorState(input: {
  readonly recentlyViewedFiles: readonly Parameters<typeof editorFile>[0][]
  readonly visibleFiles: readonly Parameters<typeof editorFile>[0][]
  readonly currentlyViewedPrs: readonly Parameters<typeof viewedPullRequest>[0][]
}): InvocationEditorState {
  return {
    recentlyViewedFiles: input.recentlyViewedFiles.map(editorFile),
    visibleFiles: input.visibleFiles.map(editorFile),
    currentlyViewedPullRequests: input.currentlyViewedPrs.map(viewedPullRequest),
  }
}

export function toSlateInvocationContext(input: InvocationContext): SlateInvocationContext {
  switch (input.data.case) {
    case "slackThread": {
      const value = input.data.value
      const conversation: InvocationThread = {
        channel: threadChannel({
          channelName: value.channelName,
          purpose: value.channelPurpose,
          topic: value.channelTopic,
        }),
        body: value.thread,
        sender: sender({ name: value.senderName, id: value.senderId, kind: value.senderType }),
      }
      return { kind: "conversation", conversation }
    }
    case "microsoftTeamsThread": {
      const value = input.data.value
      const conversation: InvocationThread = {
        channel: threadChannel({
          workspaceName: value.teamName,
          workspaceDescription: value.teamDescription,
          channelName: value.channelName,
          channelDescription: value.channelDescription,
        }),
        body: value.thread,
      }
      return { kind: "conversation", conversation }
    }
    case "ideState": {
      const value = input.data.value
      return {
        kind: "editor",
        editor: editorState({
          recentlyViewedFiles: value.recentlyViewedFiles,
          visibleFiles: value.visibleFiles,
          currentlyViewedPrs: value.currentlyViewedPrs,
        }),
      }
    }
    case "githubPr": {
      const value = input.data.value
      const pullRequest: PullRequestInvocationContext = {
        title: value.title,
        description: value.description,
        reviewComments: value.comments,
        buildFailures: value.ciFailures,
      }
      return { kind: "pull_request", pullRequest }
    }
    default:
      return { kind: "unsupported" }
  }
}

export function renderInteropInvocationPlatformContext(
  input: InvocationContext,
  enableTerminalFiles: boolean,
) {
  return renderInvocationPlatformContext(toSlateInvocationContext(input), enableTerminalFiles)
}
