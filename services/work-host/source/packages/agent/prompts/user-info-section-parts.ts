import { jsx, jsxs, Fragment, type PromptNode } from "../../prompt-jsx/index.ts"
import { isWorktreesPath } from "../../utils/paths.ts"
import { WORKTREE_NOTE } from "./worktree-note.ts"
import { MountedAgentStoresSection } from "./mounted-stores-section.ts"
import type { UserInfoMode } from "./user-info-profile-contract.ts"
import type { UserInfoEnvironment, UserInfoGitRepository } from "./user-info-data-contracts.ts"

export function workspaceLocationSection(
  env: UserInfoEnvironment,
  showNonPrimaryWarning: boolean,
): PromptNode {
  if (env.workspacePaths.length > 1) {
    return jsxs("p", {
      children: ["Workspace Paths:", jsx("br", {}), env.workspacePaths.map((path) => `- ${path}`).join("\n")],
    })
  }
  const [workspace] = env.workspacePaths
  if (workspace === undefined) return jsx("p", { children: "Workspace Path: unknown" })

  return jsxs("p", {
    children: [
      "Workspace Path: ",
      workspace,
      isWorktreesPath(workspace) && jsxs(Fragment, { children: [jsx("br", {}), WORKTREE_NOTE] }),
      showNonPrimaryWarning && jsxs(Fragment, {
        children: [jsx("br", {}), "If editing a git workspace within your current directory, do not search or edit non-primary worktrees unless the user explicitly requests you to do so."],
      }),
      showNonPrimaryWarning && env.isWorkingDirHomeDir === true && jsxs(Fragment, {
        children: [jsx("br", {}), "This applies especially to platform-managed worktrees in ~/.slate/worktrees."],
      }),
    ],
  })
}

export function gitRepositoryStatus(
  hasRepositories: boolean,
  isComplete: boolean | undefined,
  repositories: readonly UserInfoGitRepository[],
): string {
  const locations = hasRepositories
    ? repositories.length > 1
      ? `at:\n${repositories.map(({ path }) => `- ${path}`).join("\n")}`
      : `at ${repositories[0]!.path}`
    : ""
  if (isComplete === false) {
    return hasRepositories
      ? `Yes (potentially incomplete while git repository detection is still warming), currently found ${locations}`
      : "Unknown (git repository detection still warming)"
  }
  return hasRepositories ? `Yes, ${locations}` : "No"
}

export function mountedStoresSection(env: UserInfoEnvironment): PromptNode | undefined {
  const stores = env.mountedAgentStores ?? []
  return stores.length === 0
    ? undefined
    : jsx(MountedAgentStoresSection as unknown as (props: Record<string, unknown>) => PromptNode, { stores })
}

export function agentNotesSections(args: {
  readonly largeContextModel: boolean
  readonly mode?: UserInfoMode | undefined
  readonly metaAgentNotesEnabled?: boolean | undefined
  readonly sharedNotesFolder?: string | undefined
  readonly conversationNotesFolder?: string | undefined
  readonly metaAgentNotesDirectory?: string | undefined
}): PromptNode[] {
  const metaAgent = args.metaAgentNotesEnabled === true
  if (args.largeContextModel && args.mode !== "project" && !metaAgent) return []

  const paths: PromptNode[] = []
  if (!metaAgent && args.sharedNotesFolder !== undefined && args.sharedNotesFolder.length > 0) {
    paths.push(jsxs("p", { children: ["Agent shared notes folder: ", args.sharedNotesFolder] }))
  }

  const personalFolder = metaAgent ? args.metaAgentNotesDirectory : args.conversationNotesFolder
  if (personalFolder !== undefined && personalFolder.length > 0) {
    paths.push(jsx("p", {
      children: metaAgent
        ? `Meta-agent notes folder: ${personalFolder}`
        : `Agent conversation notes folder: ${personalFolder}`,
    }))
  }
  return paths
}
