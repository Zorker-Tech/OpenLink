import { jsx, jsxs, type PromptNode } from "../../prompt-jsx/index.ts"

const REQUEST_PROOF = " The request may be in the current message or an applicable user rule."

export function CommittingChangesSection(props: {
  readonly shellToolName: string
  readonly requireExplicitUserRequestProof?: boolean | undefined
}): PromptNode {
  const proof = props.requireExplicitUserRequestProof === true ? REQUEST_PROOF : ""
  const shell = props.shellToolName
  return jsxs("section", {
    title: "Creating a commit",
    children: [
      jsx("p", { children: "Create a commit only when the user clearly asks for one. Ask if the request could mean review or editing instead." }),
      jsx("p", { children: "Keep these boundaries while preparing it:" }),
      jsxs("ul", {
        children: [
          jsx("li", { children: "Leave git configuration unchanged." }),
          jsxs("li", { children: ["Do not use history-rewriting or destructive commands such as hard reset or force push unless requested.", proof] }),
          jsxs("li", { children: ["Do not bypass hooks with --no-verify or --no-gpg-sign unless requested.", proof] }),
          jsx("li", { children: "Never force-push main or master; warn the user if they ask." }),
          jsx("li", { children: "Avoid amend. It is allowed only when requested, or when a successful commit's hook changed files that must be included; in either case confirm the commit is yours and has not been pushed." }),
          jsx("li", { children: "If a commit fails or a hook rejects it, fix the cause and make a new commit. Never amend the failed attempt." }),
          jsxs("li", { children: ["Do not amend after a push unless the user explicitly accepts rewriting the remote history.", proof] }),
          jsxs("li", { children: ["Commit only after an explicit request.", proof] }),
        ],
      }),
      jsxs("ol", {
        children: [
          jsxs("li", {
            children: [
              "Inspect the repository in parallel with the ", shell, " tool:",
              jsxs("ul", {
                children: [
                  jsx("li", { children: "git status --short, including untracked files" }),
                  jsx("li", { children: "git diff and git diff --cached" }),
                  jsx("li", { children: "git log -5 --oneline" }),
                ],
              }),
            ],
          }),
          jsxs("li", {
            children: [
              "Review every staged change, then draft a short message about why the change matters. Leave secret-bearing files out.",
              jsxs("ul", {
                children: [
                  jsx("li", { children: "Use add only for files relevant to this request." }),
                  jsx("li", { children: "Do not create an empty commit." }),
                ],
              }),
            ],
          }),
          jsxs("li", {
            children: [
              "Commit sequentially and verify the result with git status. Pass the message through a heredoc:",
              jsx("x", { tag: "example", children: "git commit -m \"$(cat <<'EOF'\nDescribe why this change was requested.\nEOF\n)\"" }),
            ],
          }),
        ],
      }),
      jsxs("ul", {
        children: [
          jsx("li", { children: "Do not push unless the user asks." }),
          jsx("li", { children: "Avoid interactive git commands such as add -i or rebase -i." }),
          jsx("li", { children: "For this commit task, use git commands for repository inspection; do not run unrelated source exploration." }),
        ],
      }),
    ],
  })
}
