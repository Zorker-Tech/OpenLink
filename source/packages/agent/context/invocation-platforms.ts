import { extractTerminalId } from "../../utils/managed-paths.ts";
import { renderPullRequestInvocationContext, type PullRequestInvocationContext } from "./pull-request-invocation-context.ts";

export interface InvocationTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface InvocationThreadChannel {
  readonly workspaceName?: string | undefined;
  readonly workspaceDescription?: string | undefined;
  readonly channelName?: string | undefined;
  readonly channelDescription?: string | undefined;
  readonly purpose?: string | undefined;
  readonly topic?: string | undefined;
}

export interface InvocationThreadSender {
  readonly name?: string | undefined;
  readonly id?: string | undefined;
  readonly kind?: string | undefined;
}

export interface InvocationThread {
  readonly channel?: InvocationThreadChannel | undefined;
  readonly body?: string | undefined;
  readonly sender?: InvocationThreadSender | undefined;
}

export interface InvocationEditorFile {
  readonly path: string;
  readonly totalLines?: number | undefined;
  readonly activeCommand?: string | undefined;
  readonly cursorLine?: number | undefined;
}

export interface InvocationPullRequestSummaryFile {
  readonly path: string;
  readonly diffFileName?: string | undefined;
  readonly status?: unknown;
  readonly diffLines?: unknown;
  readonly diffSizeChars?: unknown;
  readonly diffSizeBytes?: unknown;
  readonly originalSizeChars?: unknown;
  readonly originalSizeBytes?: unknown;
}

export interface InvocationPullRequestSummary {
  readonly headRef?: string | undefined;
  readonly baseRef?: string | undefined;
  readonly totalFiles?: unknown;
  readonly totalDiffLines?: unknown;
  readonly totalDiffSizeChars?: unknown;
  readonly totalDiffSizeBytes?: unknown;
  readonly files?: readonly InvocationPullRequestSummaryFile[];
}

export interface InvocationViewedPullRequest {
  readonly number: number;
  readonly title?: string | undefined;
  readonly url?: string | undefined;
  readonly description?: string | undefined;
  readonly folderPath?: string | undefined;
  readonly summaryJson?: string | undefined;
}

export interface InvocationEditorState {
  readonly recentlyViewedFiles: readonly InvocationEditorFile[];
  readonly visibleFiles: readonly InvocationEditorFile[];
  readonly currentlyViewedPullRequests?: readonly InvocationViewedPullRequest[] | undefined;
}

export type SlateInvocationContext =
  | { readonly kind: "conversation"; readonly conversation: InvocationThread }
  | { readonly kind: "editor"; readonly editor: InvocationEditorState }
  | { readonly kind: "pull_request"; readonly pullRequest: PullRequestInvocationContext }
  | { readonly kind: "unsupported" };

export function formatInvocationSenderLine(
  senderName?: string,
  senderId?: string,
  senderKind?: string,
): string | undefined {
  const name = senderName?.trim();
  const id = senderId?.trim();
  const hasName = name !== undefined && name.length > 0;
  const hasId = id !== undefined && id.length > 0;
  if (!hasName && !hasId) return undefined;

  const kind = senderKind?.trim();
  const kindSuffix = kind !== undefined && kind.length > 0 ? " (" + kind + ")" : "";
  const label = hasName && hasId ? name + " (" + id + ")" : hasName ? name : id!;
  return "The current message is being sent by " + label + kindSuffix;
}

function channelHasDetails(channel: InvocationThreadChannel): boolean {
  return [
    channel.workspaceName,
    channel.workspaceDescription,
    channel.channelName,
    channel.channelDescription,
    channel.purpose,
    channel.topic,
  ].some((value) => value !== undefined && value.length > 0);
}

function renderThreadChannel(channel: InvocationThreadChannel): string {
  let section = "<conversation_channel>\n";
  if (channel.workspaceName) section += "Workspace: " + channel.workspaceName + "\n";
  if (channel.workspaceDescription) section += "Workspace details: " + channel.workspaceDescription + "\n";
  if (channel.channelName) section += "Channel: #" + channel.channelName + "\n";
  if (channel.channelDescription) section += "Channel details: " + channel.channelDescription + "\n";
  if (channel.purpose) section += "Channel purpose: " + channel.purpose + "\n";
  if (channel.topic) section += "Channel topic: " + channel.topic + "\n";
  return section + "</conversation_channel>\n";
}

function renderConversationThread(conversation: InvocationThread): string {
  let content = "<conversation_context>\n";
  const channel = conversation.channel;
  if (channel !== undefined && channelHasDetails(channel)) {
    content += renderThreadChannel(channel);
  }

  const senderLine = conversation.sender === undefined
    ? undefined
    : formatInvocationSenderLine(
      conversation.sender.name,
      conversation.sender.id,
      conversation.sender.kind,
    );
  const hasBody = conversation.body !== undefined && conversation.body.length > 0;
  if (hasBody || senderLine !== undefined) {
    content += "<conversation_thread>\n";
    if (hasBody) {
      content += "The user shared this conversation for additional context:\n";
      content += conversation.body + "\n";
    }
    if (senderLine !== undefined) content += "Sender: " + senderLine + "\n";
    content += "</conversation_thread>\n";
  }
  return content + "</conversation_context>";
}

function renderViewedPullRequest(pullRequest: InvocationViewedPullRequest): string {
  let section = "Pull request #" + pullRequest.number;
  if (pullRequest.title) section += ": " + pullRequest.title;
  section += "\n";

  if (pullRequest.url) section += "- Link: " + pullRequest.url + "\n";
  if (pullRequest.summaryJson) {
    try {
      const summary = JSON.parse(pullRequest.summaryJson) as Pick<InvocationPullRequestSummary, "headRef" | "baseRef">;
      const head = summary.headRef?.trim();
      const base = summary.baseRef?.trim();
      if (head) section += "- Branch: " + head + (base ? " → " + base : "") + "\n";
    } catch {
      // Invalid optional metadata does not replace the title or link.
    }
  }

  if (pullRequest.description) {
    const limit = 500;
    if (pullRequest.description.length > limit) {
      section += "- Description: " + pullRequest.description.slice(0, limit) +
        "... (shortened; the complete text is in summary.json)\n";
    } else {
      section += "- Description: " + pullRequest.description + "\n";
    }
  }

  if (!pullRequest.folderPath) return section;
  section += "- Review files are available in " + pullRequest.folderPath + "\n";
  section += "  - Contents:\n";
  section += "    - all.diff: complete change set\n";
  section += "    - diffs/: per-file change details\n";
  section += "    - summary.json: request and file metadata\n";
  section += "    - comments.json: review discussion\n";

  if (!pullRequest.summaryJson) return section;
  try {
    const summary = JSON.parse(pullRequest.summaryJson) as InvocationPullRequestSummary;
    const diffSize = summary.totalDiffSizeChars ?? summary.totalDiffSizeBytes;
    section += "- Summary: " + summary.totalFiles + " files, " +
      summary.totalDiffLines + " lines, " + diffSize + " characters\n";
    section += "- Files changed:\n";
    for (const file of summary.files ?? []) {
      const diffFileName = file.diffFileName ?? file.path.replace(/\//g, "__") + ".diff";
      const diffChars = file.diffSizeChars ?? file.diffSizeBytes;
      const originalChars = file.originalSizeChars ?? file.originalSizeBytes;
      section += "  - " + file.path + " (diff: diffs/" + diffFileName + ")\n";
      section += "    " + file.status + ", " + file.diffLines + " changed lines, " + diffChars + " characters";
      if (originalChars !== undefined) section += ", " + originalChars + " original characters";
      section += "\n";
    }
  } catch {
    section += "- Read summary.json for the file list and change sizes.\n";
  }
  return section;
}

function editorFilePath(file: InvocationEditorFile): string {
  let result = "- " + file.path;
  if (file.cursorLine !== undefined) {
    result += " (focused file, cursor on line " + file.cursorLine;
    if (file.totalLines !== undefined && file.totalLines !== -1) {
      result += ", " + file.totalLines + " total lines";
    }
    return result + ")";
  }
  if (file.totalLines !== undefined && file.totalLines !== -1) {
    result += " (" + file.totalLines + " total lines)";
  }
  return result;
}

function renderEditorState(state: InvocationEditorState, enableTerminalFiles: boolean): string {
  const includeFile = (file: InvocationEditorFile) =>
    enableTerminalFiles || extractTerminalId(file.path) === null;
  const recent = state.recentlyViewedFiles.filter(includeFile);
  const visible = state.visibleFiles.filter(includeFile);

  let recentSection = "";
  if (recent.length > 0) {
    recentSection = "Recently viewed workspace files (newest last):\n";
    for (const file of [...recent].reverse()) {
      let line = "- " + file.path;
      if (file.totalLines !== undefined && file.totalLines !== -1) {
        line += " (" + file.totalLines + " total lines)";
      }
      if (file.activeCommand && enableTerminalFiles) line += " (active command: " + file.activeCommand + ")";
      recentSection += line + "\n";
    }
    recentSection += "\n";
  }

  let visibleSection = "";
  if (visible.length === 0) {
    visibleSection = "No workspace files are open in the editor.\n";
  } else {
    visibleSection = "Workspace files currently open in the editor:\n";
    for (const file of visible) {
      let line = editorFilePath(file);
      if (file.activeCommand && enableTerminalFiles) line += " (active command: " + file.activeCommand + ")";
      visibleSection += line + "\n";
    }
  }

  let pullRequestSection = "";
  const pullRequests = state.currentlyViewedPullRequests ?? [];
  if (pullRequests.length > 0) {
    pullRequestSection = pullRequests.length === 1
      ? "\nPull request currently being viewed:\n"
      : "\nPull requests currently being viewed:\n";
    for (const pullRequest of pullRequests) {
      pullRequestSection += renderViewedPullRequest(pullRequest);
    }
  }

  return "<workspace_editor_context>\n" +
    recentSection + visibleSection + pullRequestSection +
    "\nThese files may be unrelated to the current conversation. Use the workspace file reader when you need their contents.\n" +
    "</workspace_editor_context>";
}

export function renderInvocationPlatformContext(
  context: SlateInvocationContext,
  enableTerminalFiles: boolean,
): InvocationTextContent | undefined {
  if (context.kind === "conversation") {
    return { type: "text", text: renderConversationThread(context.conversation) };
  }
  if (context.kind === "editor") {
    return { type: "text", text: renderEditorState(context.editor, enableTerminalFiles) };
  }
  if (context.kind === "pull_request") {
    return { type: "text", text: renderPullRequestInvocationContext(context.pullRequest) };
  }
  return undefined;
}
