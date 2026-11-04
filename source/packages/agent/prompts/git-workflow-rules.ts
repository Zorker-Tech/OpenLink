import { jsx, renderContent, type PromptNode } from "../../prompt-jsx/index.ts"
import { CommittingChangesSection } from "./git-commit-safety-section.ts"
import { CreatingPullRequestsSection } from "./git-pull-request-section.ts"

export { CommittingChangesSection } from "./git-commit-safety-section.ts"
export { CreatingPullRequestsSection } from "./git-pull-request-section.ts"

interface GitToolInfo {
  readonly allTools?: { readonly SHELL?: { readonly name?: string | undefined } | undefined } | undefined
}

export function getGitWorkflowUserRules(toolInfo: GitToolInfo, enablePrCreationForgeGuidance = false): string[] {
  const shellToolName = toolInfo.allTools?.SHELL?.name ?? "Shell"
  return [
    renderContent(jsx(CommittingChangesSection as unknown as (props: Record<string, unknown>) => PromptNode, {
      shellToolName,
      requireExplicitUserRequestProof: true,
    })),
    renderContent(jsx(CreatingPullRequestsSection as unknown as (props: Record<string, unknown>) => PromptNode, {
      shellToolName,
      enablePrCreationForgeGuidance,
    })),
  ]
}
