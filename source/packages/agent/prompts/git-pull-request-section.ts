import { jsx, jsxs, type PromptNode } from "../../prompt-jsx/index.ts"

export function CreatingPullRequestsSection(props: {
  readonly shellToolName: string
  readonly enablePrCreationForgeGuidance?: boolean | undefined
}): PromptNode {
  const shell = props.shellToolName
  return jsxs("section", {
    title: "Opening a pull request",
    children: [
      jsxs("p", { children: ["Use ", shell, " with gh for GitHub issues, requests, checks and releases. When the user provides a GitHub URL, inspect it with gh."] }),
      props.enablePrCreationForgeGuidance === true && jsx("p", {
        children: "If a preferred pull-request host is already named in a user instruction, it takes priority over the gh pr create steps below. It may name gh pr create or this platform's origin pr create; origin can name that host rather than the git remote. With gt, select the host using --github or --origin. Keep using gh for other GitHub tasks unless the instruction covers them too.",
      }),
      jsx("p", { children: "When asked to open a pull request, follow this review sequence:" }),
      jsxs("ol", {
        children: [
          jsxs("li", {
            children: [
              "Inspect the branch and its changes in parallel with ", shell, ":",
              jsxs("ul", {
                children: [
                  jsx("li", { children: "git status --short, including untracked files" }),
                  jsx("li", { children: "git diff and git diff --cached" }),
                  jsx("li", { children: "confirm the upstream and whether the branch is current" }),
                  jsx("li", { children: "git log and git diff base...HEAD for every commit since divergence" }),
                ],
              }),
            ],
          }),
          jsx("li", { children: "Review all commits and changes that will be included. Write a short summary and a test checklist." }),
          jsxs("li", {
            children: [
              "Complete the publication steps in order:",
              jsxs("ul", {
                children: [
                  jsx("li", { children: "Create a branch only if the current branch is not suitable for this request." }),
                  jsx("li", { children: "Push with -u when the branch has no upstream and the user asked for a PR." }),
                  jsx("li", { children: "Open the pull request with the appropriate host command and a heredoc body." }),
                ],
              }),
            ],
          }),
        ],
      }),
      jsx("x", {
        tag: "example",
        children: `gh pr create --title "the request title" --body "$(cat <<'EOF'
## Summary
- Explain the user-visible change

## Test plan
- [ ] List the checks that were run
EOF
)"`,
      }),
      jsxs("ul", {
        children: [
          jsx("li", { children: "Do not change git configuration." }),
          jsx("li", { children: "Return the PR URL after it is created." }),
        ],
      }),
    ],
  })
}
