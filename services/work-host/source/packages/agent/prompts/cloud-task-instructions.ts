/**
 * What a cloud agent is told about branches, and what a pre-built snapshot means for git.
 *
 * A cloud run does not start in a repository the user is looking at: it gets a branch (or branches) of
 * its own, often more than one, and the work has to end up pushed and in a pull request. So the
 * instructions name the branch to develop on — derived from the remote when one is known, from the
 * directory when it is not, and labelled unknown when neither says anything — and spell out the loop of
 * committing and pushing before testing rather than after.
 *
 * A workspace can hold several repositories, which changes the reading twice over: branches are
 * per-repository, and a pull request is created per branch rather than per agent. The instructions are
 * written for both cases instead of assuming one.
 *
 * The staleness notice exists because a cloud VM may boot from a snapshot with a checkout baked into
 * it, so a branch that looks current may be an hour behind. It says when to fetch and, just as
 * importantly, when not to: fetching everything preemptively throws away the reason the snapshot
 * exists.
 */

import { Fragment, jsx, jsxs, type PromptNode } from "../../prompt-jsx/index.ts"

const UNKNOWN_REPO_LABEL = "unknown-repo"
const UNKNOWN_BRANCH_NAME = "unknown-branch"

interface CloudRepositoryInfo {
  readonly path?: string | undefined
  readonly repoPath?: string | undefined
  readonly branchName?: string | undefined
  readonly baseBranch?: string | undefined
  readonly remoteUrl?: string | undefined
}

interface RepoBranchRow {
  readonly repoLabel: string
  readonly branchName: string
  readonly baseBranch?: string | undefined
}

interface RepoBranches {
  readonly displays: RepoBranchRow[]
  readonly hasUnknownBranch: boolean
}

interface ToolInventory {
  readonly allTools: Record<string, { readonly name?: string | undefined } | undefined>
}

/** A scp-style remote is not a URL until it is rewritten as one. */
function readRemoteUrl(remoteText: string): URL | null {
  try {
    let normalizedRemote = remoteText
    if (remoteText.includes("@") && !remoteText.startsWith("http")) {
      if (!remoteText.startsWith("ssh://")) {
        normalizedRemote = remoteText.replace(/^([^@]+)@([^:]+):(.*)/, "ssh://$1@$2/$3")
      }
    }
    return new URL(normalizedRemote)
  } catch {
    return null
  }
}

/** The repository's name as its host names it: an owner/repo pair, by each host's own rules. */
function repoNameFromRemote(remoteUrl?: string): string | undefined {
  if (!remoteUrl) return undefined
  const cleanedUpstreamUrl = remoteUrl.replace("https///", "https://").replace("http///", "http://")
  if (cleanedUpstreamUrl.startsWith("gitlab-remote://")) {
    try {
      const url = new URL(cleanedUpstreamUrl)
      const projectKey = url.searchParams.get("project")
      if (projectKey) {
        if (projectKey.includes("/")) return projectKey
        return undefined
      }
    } catch {
      // Fall through to the ordinary git URL parser.
    }
  }
  const url = readRemoteUrl(cleanedUpstreamUrl)
  if (!url) return undefined
  const hostName = url.hostname.toLowerCase()
  const segments = url.pathname.split("/").filter(part => part.length > 0)
  if (segments.length > 0 && segments[segments.length - 1]!.endsWith(".git")) {
    segments[segments.length - 1] = segments[segments.length - 1]!.slice(0, -4)
  }
  const onAzureDevOps = hostName === "dev.azure.com" ||
    hostName === "ssh.dev.azure.com" ||
    hostName.endsWith(".visualstudio.com")
  if (onAzureDevOps) {
    const azureSegments = [...segments]
    if (hostName === "ssh.dev.azure.com" && azureSegments.length > 0 && azureSegments[0]!.toLowerCase() === "v3") {
      azureSegments.shift()
    }
    const keptAzureSegments = azureSegments.filter(part => part.toLowerCase() !== "_git")
    return keptAzureSegments.length >= 1 ? keptAzureSegments.join("/") : undefined
  }
  if (hostName.includes("github") || hostName.endsWith(".ghe.com")) {
    return segments.length >= 2 ? segments.slice(0, 2).join("/") : undefined
  }
  if (hostName.includes("gitlab")) return segments.length >= 1 ? segments.join("/") : undefined
  if (hostName.includes("bitbucket") || hostName.includes("stash")) {
    if (segments.length >= 3 && segments[0]!.toLowerCase() === "scm") return segments.slice(1, 3).join("/")
    if (segments.length >= 2) return segments.slice(0, 2).join("/")
    return undefined
  }
  const onGerrit = hostName.includes("gerrit")
  const gerritPrefix = segments.length > 0 && segments[0]!.toLowerCase() === "gerrit"
  if (onGerrit || gerritPrefix) {
    const gerritSegments = [...segments]
    if (gerritPrefix) gerritSegments.shift()
    if (gerritSegments.length > 0 && gerritSegments[0]!.toLowerCase() === "a") gerritSegments.shift()
    return gerritSegments.length >= 1 ? gerritSegments.join("/") : undefined
  }
  return segments.length >= 2 ? segments.slice(0, 2).join("/") : undefined
}

function branchInfoPath(repository: CloudRepositoryInfo): string | undefined {
  return "path" in repository ? repository.path : repository.repoPath
}

/** A detached head is not a branch name to develop on, so it is reported as unknown. */
function promptBranchName(branchName?: string): string {
  const cleanBranchName = branchName?.trim() ?? ""
  return cleanBranchName === "" || cleanBranchName === "HEAD" ? UNKNOWN_BRANCH_NAME : cleanBranchName
}

function lastPathSegment(rawPathValue?: string): string | undefined {
  const pathText = rawPathValue?.trim() ?? ""
  if (pathText === "") return undefined
  const nameParts = pathText.split(/[\\/]/).filter(Boolean)
  return nameParts.length > 0 ? nameParts[nameParts.length - 1] : undefined
}

function promptRepoLabel(repository: CloudRepositoryInfo): string {
  return repoNameFromRemote(repository.remoteUrl) ??
    lastPathSegment(branchInfoPath(repository)) ??
    UNKNOWN_REPO_LABEL
}

function displayInfoForRepos(repos: readonly CloudRepositoryInfo[]): RepoBranches {
  const displays = repos.map(repository => ({
    repoLabel: promptRepoLabel(repository),
    branchName: promptBranchName(repository.branchName),
    baseBranch: "baseBranch" in repository ? promptBranchName(repository.baseBranch) : undefined,
  }))
  return { displays, hasUnknownBranch: displays.some(display => display.branchName === UNKNOWN_BRANCH_NAME) }
}

function pathByRepoName(gitRepos: readonly CloudRepositoryInfo[]): Map<string, string> {
  const pathByRepo = new Map<string, string>()
  for (const repository of gitRepos) {
    if (repository.path) pathByRepo.set(promptRepoLabel(repository), repository.path)
  }
  return pathByRepo
}

/** Calendar estimates are meaningless for an agent; difficulty is described in technical terms. */
function planningEstimateGuidance(): PromptNode {
  return jsx("li", { children: "When planning or scoping work, do not estimate calendar time (e.g. days or weeks of effort). Day/week timelines are a poor fit for autonomous agents. If you need to characterize difficulty, use technical detail instead: which components or subsystems must change, how invasive the edits are, and what dependencies or risks apply." })
}

function staleSnapshotNotice({ staleBuildGitRefs }: { readonly staleBuildGitRefs?: string | undefined }): PromptNode {
  if (staleBuildGitRefs === undefined) return null
  return jsxs(Fragment, {
    children: [
      jsx("h3", { children: "Pre-built snapshot git staleness:" }),
      jsx("ul", {
        children: [
          jsxs("li", { children: ["This VM booted from a pre-built environment snapshot, reusing the git checkout baked when the snapshot was built.", " ", staleBuildGitRefs === "all_refs" ? "Local refs — including the default branch — may be behind the remote (typically by an hour or two; more if recent builds failed)." : "A best-effort refresh of the run's explicitly-requested starting refs ran at startup, but any other local ref (for example, the default branch, or repos in a multi-repo workspace without an explicit starting ref) may be behind the remote."] }),
          jsx("li", { children: "If your task depends on the latest remote state of a possibly-stale branch (e.g. branching from, rebasing onto, merging, or diffing against the latest default branch), run `git fetch origin <branch-name>` for that branch first." }),
          jsx("li", { children: "If the user references repository content that is not present in the local checkout (for example, a file or skill), treat that reference as evidence that the content may have landed after the build was created. Fetch the relevant remote branch and check its latest state before concluding that the content does not exist." }),
          jsx("li", { children: "Otherwise, do NOT fetch preemptively: the reused checkout is intentional (it makes startup fast) and is fine for most tasks." }),
        ],
      }),
    ],
  })
}

export function CloudInstructionsSection({ cloudRuleContent }: { readonly cloudRuleContent: string }): PromptNode {
  return jsxs("section", {
    title: "cloud_instructions",
    description: "Instructions pulled from AGENTS.md",
    children: [jsx("p", { children: "AGENTS.md contents:" }), jsx("br", {}), cloudRuleContent],
  })
}

export function CloudTaskInstructions({
  gitRepos,
  designatedBranches,
  branchPrefix,
  branchSuffix,
  allowMultipleBranches = false,
  preferCurrentBranchInMultiPrMode = false,
  toolInfo,
  staleBuildGitRefs,
}: {
  readonly gitRepos: readonly CloudRepositoryInfo[]
  readonly designatedBranches?: readonly CloudRepositoryInfo[] | undefined
  readonly branchPrefix?: string | undefined
  readonly branchSuffix?: string | undefined
  readonly allowMultipleBranches?: boolean | undefined
  readonly preferCurrentBranchInMultiPrMode?: boolean | undefined
  readonly toolInfo?: ToolInventory | undefined
  readonly staleBuildGitRefs?: string | undefined
}): PromptNode {
  // Which branches to name depends on the mode: designated ones win, then the current branches when the
  // run reuses them, and otherwise there is nothing to name at all.
  const branchChoice = designatedBranches !== undefined && designatedBranches.length > 0
    ? displayInfoForRepos(designatedBranches)
    : allowMultipleBranches && preferCurrentBranchInMultiPrMode
      ? displayInfoForRepos(gitRepos)
      : allowMultipleBranches
        ? { displays: [], hasUnknownBranch: false }
        : displayInfoForRepos(gitRepos)
  const branchRows = branchChoice.displays
  const unknownBranchPresent = branchChoice.hasUnknownBranch
  const managedPrToolName = toolInfo?.allTools.PR_MANAGEMENT?.name
  const hasManagedPrTool = managedPrToolName !== undefined
  const prManagementToolReference = managedPrToolName !== undefined ? `\`${managedPrToolName}\` tool` : "PR management tool"
  const currentBranchFromGitRepos = allowMultipleBranches
    ? displayInfoForRepos(gitRepos).displays[0]?.branchName
    : undefined
  const branchNameTemplate = branchPrefix !== undefined || branchSuffix !== undefined
    ? `${branchPrefix ?? ""}<descriptive-name>${branchSuffix ?? ""}`
    : "<branch-name>"
  const branchCreationCommand = `git checkout -b ${branchNameTemplate}`
  const multiRepo = gitRepos.length > 1
  const managedPrWriteGuidance = managedPrToolName === undefined
    ? ""
    : multiRepo
      ? " Do not use `gh` to create or update pull requests. For `create_pr`, pass `action`, `title`, `body`, `branch_name`, `base_branch`, and `remote_url`. For `update_pr`, pass `action`, `remote_url`, either `branch_name` or `pr_url`, and at least one of `title`, `body`, or `base_branch`."
      : " Do not use `gh` to create or update pull requests. For `create_pr`, pass `action`, `title`, `body`, `branch_name`, and `base_branch`. For `update_pr`, pass `action`, either `branch_name` or `pr_url`, and at least one of `title`, `body`, or `base_branch`."
  const repoPathLookup = multiRepo ? pathByRepoName(gitRepos) : undefined
  return jsxs("section", {
    title: "cloud_task_instructions",
    children: [
      jsx("p", { children: "As a Cloud Agent, you are helping with GitHub issues and pull requests. Your task is to complete the request described in the `user_query`." }),
      jsx("ul", { children: jsx(planningEstimateGuidance, {}) }),
      jsx("h2", { children: "Git Development Branch Requirements" }),
      multiRepo && allowMultipleBranches && jsx("p", { children: "This workspace contains multiple git repositories. Each branch listed below is associated with a specific repository and local directory. Make sure to run git commands from the correct repository directory." }),
      jsx("p", {
        children: allowMultipleBranches
          ? preferCurrentBranchInMultiPrMode
            ? `You are currently on the existing branch${currentBranchFromGitRepos !== undefined && currentBranchFromGitRepos !== UNKNOWN_BRANCH_NAME ? ` \`${currentBranchFromGitRepos}\`` : ""}. The user likely wants changes to happen on this branch rather than on a new one. Reuse the current branch by default${hasManagedPrTool ? `, and use the ${prManagementToolReference} to register or update it` : ""} unless the user explicitly asks for separate branch work.`
            : `You are currently on the base branch${currentBranchFromGitRepos !== undefined && currentBranchFromGitRepos !== UNKNOWN_BRANCH_NAME ? ` \`${currentBranchFromGitRepos}\`` : ""}. Create feature branches off of it for your work${hasManagedPrTool ? ", and use it as the default `base_branch` when creating PRs" : ""} unless the user specifies differently. If this agent already has registered PR branches, they are listed here for context:`
          : "You are working on the following feature branches:",
      }),
      branchRows.length > 0
        ? jsx("ul", {
          children: branchRows.map(display => jsxs("li", {
            children: [
              allowMultipleBranches && !preferCurrentBranchInMultiPrMode
                ? `**${display.repoLabel}**: PR branch \`${display.branchName}\``
                : `**${display.repoLabel}**: Develop on branch \`${display.branchName}\``,
              multiRepo && allowMultipleBranches && repoPathLookup?.get(display.repoLabel) !== undefined &&
                ` (repo directory: \`${repoPathLookup.get(display.repoLabel)}\`)`,
              display.baseBranch !== undefined && display.baseBranch !== UNKNOWN_BRANCH_NAME &&
                ` (base branch: \`${display.baseBranch}\`)`,
            ],
          })),
        })
        : jsx("p", {
          children: allowMultipleBranches
            ? preferCurrentBranchInMultiPrMode
              ? "If the current branch is not yet tracked by PR management, register it before creating any new branch."
              : `No PR branches are registered yet. Use \`${branchCreationCommand}\` to create a new branch when you need one.`
            : "No git repository info was provided in `RequestContext.git_repos`. Run `git symbolic-ref --short HEAD` to determine which branch you should develop on.",
        }),
      unknownBranchPresent && jsx("p", {
        children: multiRepo && allowMultipleBranches
          ? "If a branch name is missing or shows as `HEAD`, run `git symbolic-ref --short HEAD` in the corresponding repo directory to confirm the branch you should use."
          : "If the branch name is missing or shows as `HEAD`, run `git symbolic-ref --short HEAD` in the repo to confirm the branch you should use.",
      }),
      jsx("h3", { children: "Important Instructions:" }),
      allowMultipleBranches
        ? jsxs(Fragment, {
          children: [
            jsxs("ol", {
              children: [
                jsxs("li", {
                  children: [
                    preferCurrentBranchInMultiPrMode
                      ? "**REUSE THE CURRENT BRANCH BY DEFAULT**. Make your changes on the current branch unless the user explicitly asks for a separate branch or PR."
                      : branchPrefix !== undefined || branchSuffix !== undefined
                        ? `**CREATE BRANCHES AS NEEDED** using normal git commands like \`${branchCreationCommand}\`. Every new branch name must match the template \`${branchNameTemplate}\`.`
                        : `**CREATE BRANCHES AS NEEDED** using normal git commands like \`${branchCreationCommand}\``,
                    branchPrefix !== undefined && ` Use the prefix \`${branchPrefix}\` for all branch names you create.`,
                    branchSuffix !== undefined && ` Append the suffix \`${branchSuffix}\` to all branch names you create.`,
                    multiRepo && " When working across multiple repositories, create branches in each repo as needed.",
                    " Always use lowercase letters in branch names — case-insensitive filesystems (macOS and Windows defaults) cannot hold two branches that differ only in casing.",
                  ],
                }),
                jsx("li", { children: "**COMMIT** your work with clear, descriptive commit messages" }),
                jsx("li", { children: "**PUSH** each working branch with normal git push commands" }),
                hasManagedPrTool && jsxs(Fragment, {
                  children: [
                    jsx("li", { children: preferCurrentBranchInMultiPrMode ? `**REGISTER OR UPDATE THE CURRENT BRANCH** using the ${prManagementToolReference}. Always set \`branch_name\` to the current branch. If you create or update a PR for this branch, set \`base_branch\` to the branch this current branch was originally based on, not the current branch itself. Avoid changing the PR title or description unless the user asks you to.${managedPrWriteGuidance}` : `**REGISTER OR CREATE PRS PER BRANCH** using the ${prManagementToolReference}. Always set \`branch_name\`, and provide \`base_branch\` when creating a PR.${managedPrWriteGuidance}` }),
                    jsx("li", { children: "**SEPARATE BRANCHES CAN HAVE SEPARATE PRS**. Do not assume one agent only has one branch or one PR." }),
                  ],
                }),
                jsxs("li", { children: ["**ALWAYS** commit and push your changes on each iteration loop as you go from implementing to testing. Before you begin testing, commit and push your changes", hasManagedPrTool ? ", then create the PR (or update the existing PR) for that pre-testing revision. If you make additional changes during or after testing, commit and push them, then update the PR before giving your summary." : "."] }),
                hasManagedPrTool && jsx("li", { children: "**CREATE OR UPDATE** the PR at the end of every turn, before giving your summary, if you have made changes during this turn." }),
              ],
            }),
            jsx("p", { children: `Remember: the branch list above is contextual, not restrictive. Create, switch${hasManagedPrTool ? ", push, and open PRs on" : ", and push"} whichever branches the task requires.` }),
          ],
        })
        : jsxs(Fragment, {
          children: [
            jsxs("ol", {
              children: [
                jsx("li", { children: "**DEVELOP** all your changes on the designated branch above" }),
                jsx("li", { children: "**COMMIT** your work with clear, descriptive commit messages" }),
                jsx("li", { children: "**PUSH** to the specified branch" }),
                jsx("li", { children: "**CREATE** the branch locally if it doesn't exist yet" }),
                jsx("li", { children: "**NEVER** push to a different branch without explicit instructions from the user." }),
                jsx("li", { children: "Commit and push your changes as you go. Multiple commits with smaller units of work are preffered to one large commit." }),
                jsxs("li", { children: ["**ALWAYS** commit and push your changes on each iteration loop as you go from implementing to testing. Before you begin testing, commit and push your changes", hasManagedPrTool ? ", then create the PR (or update the existing PR) for that pre-testing revision. If you make additional changes during or after testing, commit and push them, then update the PR before giving your summary." : "."] }),
                hasManagedPrTool && jsx("li", { children: "**CREATE OR UPDATE** the PR at the end of every turn, before giving your summary, if you have made changes during this turn." }),
              ],
            }),
            jsx("p", { children: "Remember: All development and final pushes should go to the branches specified above." }),
          ],
        }),
      jsx("h2", { children: "Git Operations" }),
      jsx("p", { children: "Follow these practices for git:" }),
      jsx(staleSnapshotNotice as unknown as (props: Record<string, unknown>) => PromptNode, { staleBuildGitRefs }),
      jsx("h3", { children: "For git push:" }),
      jsx("ul", {
        children: [
          jsx("li", { children: "Always use `git push -u origin <branch-name>`" }),
          jsx("li", { children: "Only if push fails due to network errors retry up to 4 times with exponential backoff (4s, 8s, 16s, 32s)" }),
        ],
      }),
      jsx("h3", { children: "For git fetch/pull:" }),
      jsx("ul", {
        children: [
          jsx("li", { children: "Prefer fetching specific branches: `git fetch origin <branch-name>`" }),
          jsx("li", { children: "If network failures occur, retry up to 4 times with exponential backoff (4s, 8s, 16s, 32s)" }),
          jsx("li", { children: "For pulls use: `git pull origin <branch-name>`" }),
        ],
      }),
    ],
  })
}
