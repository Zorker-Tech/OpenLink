/**
 * The sections several prompt variants share.
 *
 * A prompt for a cloud run and a prompt for a local one are assembled from the same pieces worded the
 * same way, and these are those pieces: where a run's artifacts go, what the desktop tool is for, and
 * how git work is submitted. Writing them once is what keeps a fix to the wording from reaching only
 * one of the variants.
 */

import { AGENT_RUNTIME_PATHS } from "../../constants/cloud-agent-paths.ts"
import { Fragment, jsx, jsxs } from "../../prompt-jsx/index.ts"
import { repositoryAccessGuidance } from "./repository-access-bullets.ts"

interface PromptArtifactProps {
  readonly env?: { readonly artifactsFolder?: string | undefined } | undefined
}

/** A directory a path is joined onto has to end in a separator; which one depends on the machine. */
function normalizePromptArtifactsDir(artifactsDir: string): string {
  if (artifactsDir.endsWith("/") || artifactsDir.endsWith("\\")) return artifactsDir
  return artifactsDir.includes("\\") && !artifactsDir.includes("/") ? `${artifactsDir}\\` : `${artifactsDir}/`
}

export function resolvePromptArtifactsDir(props: PromptArtifactProps): string {
  const reported = props.env?.artifactsFolder?.trim()
  const artifactsDir = reported !== undefined && reported.length > 0 ? reported : AGENT_RUNTIME_PATHS.artifactCollectionDirectory
  return normalizePromptArtifactsDir(artifactsDir)
}

interface ComputerUseToolInfo {
  readonly allTools: Record<string, { readonly name: string } | undefined>
}

interface ComputerUsePromptProps {
  readonly subagentType?: { readonly type?: { readonly case?: string | undefined } | undefined } | undefined
  readonly toolInfo: ComputerUseToolInfo
}

function getRequiredToolName(allTools: ComputerUseToolInfo["allTools"], toolId: string): string {
  const tool = allTools[toolId]
  if (!tool) throw new Error(`Required tool ${toolId} not found in allTools`)
  return tool.name
}

/**
 * What the agent is told about driving the desktop. The subagent that exists only to drive it is told
 * less — it already knows why it is there — and is told which tool to use for commands instead.
 */
export function ComputerUseInstructionsSection({ props }: { readonly props: ComputerUsePromptProps }) {
  const isComputerUseSubagent = props.subagentType?.type?.case === "computerUse"
  const reflectToolName = isComputerUseSubagent ? props.toolInfo.allTools.REFLECT?.name : undefined
  return jsxs("section", {
    title: "computer_use",
    children: [
      jsx("p", { children: "You have access to the `computer` tool which allows you to interact with the desktop." }),
      jsx("h2", { children: "When to Use Computer-Use" }),
      isComputerUseSubagent
        ? jsxs("p", { children: ["Use the `computer` tool to interact with the desktop and browser. NEVER use the `computer` tool to run (non-terminal-UI-dependent) shell commands, use the `", getRequiredToolName(props.toolInfo.allTools, "SHELL"), "` tool instead."] })
        : jsxs(Fragment, {
          children: [
            jsx("p", { children: "Use the `computer` tool when you need to:" }),
            jsxs("ul", {
              children: [
                jsx("li", { children: "Manually test built applications / websites and UI changes" }),
                jsx("li", { children: "Verify that UI changes are working correctly" }),
                jsx("li", { children: "Interact with built applications / websites" }),
                jsx("li", { children: "Capture screenshots for visual verification" }),
              ],
            }),
          ],
        }),
      jsx("h2", { children: "Tool Usage" }),
      jsx("p", { children: "The `computer` tool accepts a list of actions to execute sequentially. Each action will be performed in order, and a screenshot will be captured after all actions complete." }),
      jsx("p", { children: "Available actions include:" }),
      jsxs("ul", {
        children: [
          jsx("li", { children: "`mouse_move`: Move mouse to coordinates" }),
          jsx("li", { children: "`left_click`: Click at coordinates or on an element" }),
          jsx("li", { children: "`left_click_drag`: Drag from one point to another" }),
          jsx("li", { children: "`right_click`, `middle_click`: Right/middle click" }),
          jsx("li", { children: "`scroll`: Scroll page or element" }),
          jsx("li", { children: "`type`: Type text at current focus. When typing multi-line text, unescaped newlines (\\n) and carriage returns (\\r) will be converted to Enter key presses." }),
          jsx("li", { children: "`key`: Press a keyboard key or key combination. Supports xdotool-style syntax: \"ctrl+a\", \"super+Tab\"" }),
          jsx("li", { children: "`wait`: Wait for time. Useful when waiting for content to appear / disappear (seconds)" }),
          jsx("li", { children: "`screenshot`: Capture a screenshot (automatically captured after actions)" }),
        ],
      }),
      reflectToolName !== undefined && jsxs(Fragment, {
        children: [
          jsxs("p", { children: ["Additionally, the `", reflectToolName, "` action is available as its own tool:"] }),
          jsx("ul", {
            children: jsxs("li", {
              children: ["`", reflectToolName, "`: Use `", reflectToolName, "` when your actions are not having the desired effect. For example, if clicking a button or scrolling is not working as expected, use the `", reflectToolName, "` tool to reflect on the current state and plan an improved approach. The `", reflectToolName, "` tool is expensive, so use it sparingly. Always include the `next_steps` field in your `", reflectToolName, "` tool calls."],
            }),
          }),
        ],
      }),
      jsx("h2", { children: "Typing Best Practices" }),
      jsxs("ul", {
        children: [
          jsx("li", { children: "IMPORTANT: Before typing into ANY text field that may contain existing text, ALWAYS clear it first by using `key` with \"Control+a\" (or \"Meta+a\" on Mac) followed by `key` with \"Backspace\". This ensures predictable state." }),
          jsx("li", { children: "NEVER type or clear text after a click action returned an error - the element may not be focused." }),
          jsx("li", { children: "If typing doesn't appear, verify the target element is focused by clicking it first." }),
        ],
      }),
      jsx("h2", { children: "Best Practices" }),
      jsxs("ul", {
        children: [
          jsx("li", { children: "Wait for elements to appear before interacting with them" }),
          jsx("li", { children: "Test key user flows and edge cases" }),
          jsx("li", { children: "Provide evidence (screenshots) when demonstrating that your work" }),
          jsx("li", { children: "If a click action fails due to page changes during execution, evaluate the new screenshot and retry the action at the updated coordinates." }),
        ],
      }),
      jsx("h2", { children: "Evidence for Testing" }),
      jsxs("p", {
        children: [
          "The `computer` tool returns a `screenshot_path` field indicating where the screenshot was saved.",
          " ",
          isComputerUseSubagent && "Use this exact path in your img tags when referencing screenshots.",
        ],
      }),
      jsx("p", { children: "Always include screenshot(s) in your response to demonstrate your work." }),
    ],
  })
}

const NO_FORCE_PUSH_OR_AMEND_COMMITS_NOTE = "Do not force push or amend commits unless explictly instructed to do so."

interface GitInstructionsProps {
  readonly toolInfo: ComputerUseToolInfo
  readonly shouldShowTestingInstructions?: boolean | undefined
  readonly suppressCreatedPrMention?: boolean | undefined
  readonly canMarkPrReady?: boolean | undefined
}

function NoRepositoryAccessInstructions() {
  const { boundary, nextStep } = repositoryAccessGuidance()
  return [
    jsx("li", { children: boundary }),
    jsx("li", { children: nextStep }),
  ]
}

/**
 * How work is submitted. Where the environment manages pull requests itself the agent is told to leave
 * them alone; where it has a tool for them the tool is named, together with what the platform will not
 * do on its own — merging, or moving a pull request's merge state.
 */
function GitInstructions({ toolInfo, shouldShowTestingInstructions, suppressCreatedPrMention = false, canMarkPrReady = false }: GitInstructionsProps) {
  const prToolName = toolInfo.allTools.PR_MANAGEMENT?.name
  const hasPrTool = prToolName !== undefined
  return [
    jsxs("li", { children: ["You are responsible for managing all git operations", !hasPrTool && " outside of PRs/MRs", ". When you have completed changes to the codebase and are ready to submit them, you MUST run `git add` to stage your changes, `git commit` to commit them with a descriptive message, and `git push` to push them to the remote repository."] }),
    jsx("li", { children: "The git client on this repository path already has `user.name` and `user.email` configured. Use that existing git config for commits, and do not override it unless the user explicitly asks you to." }),
    jsx("li", { children: "When commiting, create a new commit for each logical change. Do not batch commits unless explictly instructed to do so." }),
    jsx("li", { children: NO_FORCE_PUSH_OR_AMEND_COMMITS_NOTE }),
    jsx("li", { children: "Do not leave the current git branch unless the user explicitly asks you to do so." }),
    jsxs("li", { children: ["Do not merge pull requests or enable auto-merge (for example, `gh pr merge`, including the `--auto` flag)", !canMarkPrReady && ", and do not mark pull requests as ready for review or otherwise change a pull request's merge state", ". Only do ", canMarkPrReady ? "this" : "any of the above", " if the user explicitly instructs you to do so."] }),
    hasPrTool
      ? jsxs("li", { children: ["You can create or update pull requests using the ", prToolName, " tool. Use it to create PRs after pushing your changes, or to update PR titles and descriptions. At the end of every turn, before giving your summary, create or update the PR if you have made changes to the branch. PRs are created as draft by default unless the user specifies otherwise.", canMarkPrReady && " When the PR is ready for human review, mark it ready by calling update_pr with draft set to false.", " ", "Before creating a PR, check for a PR template (e.g. PULL_REQUEST_TEMPLATE.md, .github/PULL_REQUEST_TEMPLATE.md, or PULL_REQUEST_TEMPLATE/*.md) and use it to populate the body if one exists", !suppressCreatedPrMention && ". You should not mention the created PR to the user unless explicitly asked to", shouldShowTestingInstructions ? ". If you captured relevant artifacts (images/videos), include them in the PR body using HTML img/video tags with absolute file paths (do NOT worry about making the artifact file publicly accessible or adding it to the repo, just reference the path as-is and the tool will handle the rest)." : "."] })
      : jsx("li", { children: "This remote environment will handle PRs/MRs automatically. Do not attempt to create, update, or merge PRs/MRs yourself unless the user explicitly asks you to do so." }),
  ]
}

export function GitOrNoRepositoryInstructions({ isRepoless, gitInstructionsProps }: {
  readonly isRepoless?: boolean | undefined
  readonly gitInstructionsProps: GitInstructionsProps
}) {
  return isRepoless === true ? NoRepositoryAccessInstructions() : GitInstructions(gitInstructionsProps)
}
