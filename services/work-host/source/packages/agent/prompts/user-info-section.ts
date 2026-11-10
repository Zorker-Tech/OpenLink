import { jsx, jsxs, type PromptNode } from "../../prompt-jsx/index.ts"
import { mountedStoresSection, workspaceLocationSection, gitRepositoryStatus, agentNotesSections } from "./user-info-section-parts.ts"
import type { UserInfoMode } from "./user-info-profile-contract.ts"
import type { UserInfoEnvironment, UserInfoGitRepository } from "./user-info-data-contracts.ts"

export interface UserInfoSectionProps {
  readonly env: UserInfoEnvironment
  readonly isLargeContextModel?: boolean | undefined
  readonly mode?: UserInfoMode | undefined
  readonly hasGitRepos: boolean
  readonly gitRepoInfoComplete?: boolean | undefined
  readonly gitRepos: readonly UserInfoGitRepository[]
  readonly todaysDate?: string | undefined
  readonly terminalsFolder?: string | undefined
  readonly agentSharedNotesFolder?: string | undefined
  readonly agentConversationNotesFolder?: string | undefined
  readonly metaAgentNotesDirectory?: string | undefined
  readonly metaAgentNotesEnabled?: boolean | undefined
  readonly displayTodaysDate: boolean
  readonly displayGitRepoStatusLine: boolean
}

export function UserInfoSection(props: UserInfoSectionProps): PromptNode {
  const largeContextModel = props.isLargeContextModel === true
  const showNonPrimaryWarning = !props.hasGitRepos && props.gitRepoInfoComplete !== false
  const repositoryStatus = gitRepositoryStatus(props.hasGitRepos, props.gitRepoInfoComplete, props.gitRepos)
  const common = [
    jsxs("p", { children: ["OS Version: ", props.env.osVersion] }),
    jsxs("p", { children: ["Shell: ", props.env.shell ?? "bash"] }),
    workspaceLocationSection(props.env, showNonPrimaryWarning),
    ...(props.displayGitRepoStatusLine
      ? [jsxs("p", { children: ["Is directory a git repo: ", repositoryStatus] })]
      : []),
  ]
  const notes = agentNotesSections({
    largeContextModel,
    mode: props.mode,
    metaAgentNotesEnabled: props.metaAgentNotesEnabled,
    sharedNotesFolder: props.agentSharedNotesFolder,
    conversationNotesFolder: props.agentConversationNotesFolder,
    metaAgentNotesDirectory: props.metaAgentNotesDirectory,
  })
  const terminals = props.terminalsFolder === undefined
    ? []
    : [jsxs("p", { children: ["Terminals folder: ", props.terminalsFolder] })]
  const mountedStores = mountedStoresSection(props.env)
  const mounted = mountedStores === undefined ? [] : [mountedStores]
  const date = !props.displayTodaysDate
    ? []
    : [jsxs("p", { children: ["Today's date: ", props.todaysDate] })]

  const children: PromptNode[] = largeContextModel
    ? [...common, ...terminals, ...mounted, ...date, ...notes, jsx("p", { children: "Note: Prefer using absolute paths over relative paths as tool call args when possible." })]
    : [...common, ...date, ...terminals, ...mounted, ...notes]
  return jsxs("section", { title: "user_info", children })
}
