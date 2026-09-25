/**
 * The context block: what the agent is told about the machine it is working on.
 *
 * Everything here is a fact the agent cannot discover cheaply and would otherwise guess wrong: the
 * operating system, the shell, where the workspace is, whether it is a git repository, which folders
 * hold terminals and notes, what day it is, and which stores are mounted. It is the first section of the
 * first user message, and every later turn reuses it — which is why the platform watches it for changes
 * rather than rebuilding it each time.
 *
 * Two things about the workspace are worth warning about rather than merely stating. A session started
 * in a worktree is inside its own checkout, and editing outside it would disturb the user's tree. And
 * when git repository detection is still warming, the absence of a repository is reported as unknown
 * rather than as no — a warning about non-primary worktrees would be wrong while the answer is unknown.
 *
 * One model family reads a slightly different version, which also names the notes folders whenever the
 * session could write notes, rather than only when they exist.
 */

import { AgentMode } from "../../proto/generated/agent/v1/agent_pb.ts"
import type { GitRepoInfo, RequestContextEnv } from "../../proto/generated/agent/v1/request_context_exec_pb.ts"
import { jsx, jsxs, Fragment, type PromptNode } from "../../prompt-jsx/index.ts"
import { isWorktreesPath } from "../../utils/paths.ts"
import { WORKTREE_NOTE } from "./worktree-note.ts"
import { MountedAgentStoresSection } from "./mounted-stores-section.ts"

export interface UserInfoSectionProps {
  readonly env: RequestContextEnv
  readonly isLargeContextModel?: boolean | undefined
  readonly mode?: AgentMode | undefined
  readonly hasGitRepos: boolean
  readonly gitRepoInfoComplete?: boolean | undefined
  readonly gitRepos: readonly GitRepoInfo[]
  readonly todaysDate?: string | undefined
  readonly terminalsFolder?: string | undefined
  readonly agentSharedNotesFolder?: string | undefined
  readonly agentConversationNotesFolder?: string | undefined
  readonly metaAgentNotesDirectory?: string | undefined
  readonly metaAgentNotesEnabled?: boolean | undefined
  readonly displayTodaysDate: boolean
  readonly displayGitRepoStatusLine: boolean
}

export function UserInfoSection({
  env,
  isLargeContextModel,
  mode,
  hasGitRepos,
  gitRepoInfoComplete,
  gitRepos,
  todaysDate,
  terminalsFolder,
  agentSharedNotesFolder,
  agentConversationNotesFolder,
  metaAgentNotesDirectory,
  metaAgentNotesEnabled,
  displayTodaysDate,
  displayGitRepoStatusLine,
}: UserInfoSectionProps): PromptNode {
  const knownRepoText = hasGitRepos
    ? gitRepos.length > 1
      ? `at:\n${gitRepos.map(repo => `- ${repo.path}`).join("\n")}`
      : `at ${gitRepos[0]!.path}`
    : ""
  const gitRepoStatusText = gitRepoInfoComplete === false
    ? hasGitRepos
      ? `Yes (potentially incomplete while git repository detection is still warming), currently found ${knownRepoText}`
      : "Unknown (git repository detection still warming)"
    : hasGitRepos
      ? `Yes, ${knownRepoText}`
      : "No"
  const shouldShowNonPrimaryWorktreeWarning = !hasGitRepos && gitRepoInfoComplete !== false
  const mountedAgentStores = env.mountedAgentStores ?? []
  if (isLargeContextModel) {
    const shouldShowAgentNotesPaths = mode === AgentMode.PROJECT || metaAgentNotesEnabled === true
    return jsxs("section", {
      title: "user_info",
      children: [
        jsxs("p", { children: ["OS Version: ", env.osVersion] }),
        jsxs("p", { children: ["Shell: ", env.shell ?? "bash"] }),
        env.workspacePaths.length > 1
          ? jsxs("p", { children: ["Workspace Paths:", jsx("br", {}), env.workspacePaths.map(path => `- ${path}`).join("\n")] })
          : env.workspacePaths.length === 1
            ? jsxs("p", {
              children: [
                "Workspace Path: ",
                env.workspacePaths[0]!,
                isWorktreesPath(env.workspacePaths[0]!) && jsxs(Fragment, { children: [jsx("br", {}), WORKTREE_NOTE] }),
                shouldShowNonPrimaryWorktreeWarning && jsxs(Fragment, {
                  children: [jsx("br", {}), "If editing a git workspace within your current directory, do not search or edit non-primary worktrees unless the user explicitly requests you to do so."],
                }),
                shouldShowNonPrimaryWorktreeWarning && env.isWorkingDirHomeDir === true && jsxs(Fragment, {
                  children: [jsx("br", {}), "This applies especially to platform-managed worktrees in ~/.slate/worktrees."],
                }),
              ],
            })
            : jsx("p", { children: "Workspace Path: unknown" }),
        displayGitRepoStatusLine && jsxs("p", { children: ["Is directory a git repo: ", gitRepoStatusText] }),
        terminalsFolder && jsxs("p", { children: ["Terminals folder: ", terminalsFolder] }),
        mountedAgentStores.length > 0 && jsx(MountedAgentStoresSection as unknown as (props: Record<string, unknown>) => PromptNode, { stores: mountedAgentStores }),
        displayTodaysDate && jsxs("p", { children: ["Today's date: ", todaysDate] }),
        shouldShowAgentNotesPaths && metaAgentNotesEnabled !== true && agentSharedNotesFolder && jsxs("p", { children: ["Agent shared notes folder: ", agentSharedNotesFolder] }),
        shouldShowAgentNotesPaths && (metaAgentNotesEnabled === true ? metaAgentNotesDirectory : agentConversationNotesFolder) &&
          jsx("p", {
            children: metaAgentNotesEnabled === true
              ? `Meta-agent notes folder: ${metaAgentNotesDirectory}`
              : `Agent conversation notes folder: ${agentConversationNotesFolder}`,
          }),
        jsx("p", { children: "Note: Prefer using absolute paths over relative paths as tool call args when possible." }),
      ],
    })
  }
  return jsxs("section", {
    title: "user_info",
    children: [
      jsxs("p", { children: ["OS Version: ", env.osVersion] }),
      jsxs("p", { children: ["Shell: ", env.shell ?? "bash"] }),
      env.workspacePaths.length > 1
        ? jsxs("p", { children: ["Workspace Paths:", jsx("br", {}), env.workspacePaths.map(path => `- ${path}`).join("\n")] })
        : env.workspacePaths.length === 1
          ? jsxs("p", {
            children: [
              "Workspace Path: ",
              env.workspacePaths[0]!,
              isWorktreesPath(env.workspacePaths[0]!) && jsxs(Fragment, { children: [jsx("br", {}), WORKTREE_NOTE] }),
              shouldShowNonPrimaryWorktreeWarning && jsxs(Fragment, {
                children: [jsx("br", {}), "If editing a git workspace within your current directory, do not search or edit non-primary worktrees unless the user explicitly requests you to do so."],
              }),
              shouldShowNonPrimaryWorktreeWarning && env.isWorkingDirHomeDir === true && jsxs(Fragment, {
                children: [jsx("br", {}), "This applies especially to platform-managed worktrees in ~/.slate/worktrees."],
              }),
            ],
          })
          : jsx("p", { children: "Workspace Path: unknown" }),
      displayGitRepoStatusLine && jsxs("p", { children: ["Is directory a git repo: ", gitRepoStatusText] }),
      displayTodaysDate && jsxs("p", { children: ["Today's date: ", todaysDate] }),
      terminalsFolder && jsxs("p", { children: ["Terminals folder: ", terminalsFolder] }),
      mountedAgentStores.length > 0 && jsx(MountedAgentStoresSection as unknown as (props: Record<string, unknown>) => PromptNode, { stores: mountedAgentStores }),
      agentSharedNotesFolder && metaAgentNotesEnabled !== true && jsxs("p", { children: ["Agent shared notes folder: ", agentSharedNotesFolder] }),
      (metaAgentNotesEnabled === true ? metaAgentNotesDirectory : agentConversationNotesFolder) &&
        jsx("p", {
          children: metaAgentNotesEnabled === true
            ? `Meta-agent notes folder: ${metaAgentNotesDirectory}`
            : `Agent conversation notes folder: ${agentConversationNotesFolder}`,
        }),
    ],
  })
}
