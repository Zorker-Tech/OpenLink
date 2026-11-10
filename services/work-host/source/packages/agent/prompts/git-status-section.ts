import { Fragment, jsx, jsxs, type PromptNode } from "../../prompt-jsx/index.ts"
import { projectGitStatusSection, type GitStatusProjectionInput } from "./git-status-projection.ts"

export function GitStatusSection(props: GitStatusProjectionInput): PromptNode {
  const projection = projectGitStatusSection(props)
  const notes = projection.notes.map(note => jsx("p", { children: note }))
  const repositories = projection.repositories.map((repository, index) => jsxs(Fragment, {
    children: [
      ...(index === 0 ? [jsx("br", {})] : [jsx("br", {}), jsx("br", {})]),
      jsxs("p", {
        children: [
          "Git repo: ",
          repository.path,
          repository.remoteUrl === undefined ? "" : " (remote: " + repository.remoteUrl + ")",
        ],
      }),
      repository.statusBlock,
    ],
  }))
  return jsxs("section", { title: "git_status", children: [...notes, ...repositories] })
}
