import type { ExecGitNonInteractiveOptions } from "./git-command.ts"

export type PluginSourceRevisionOptions = ExecGitNonInteractiveOptions

export interface PluginSourceRevision {
  readonly fullSha: string
  readonly headSymrefStdout?: string
}

export interface RemoteCommitRecord {
  readonly sha: string
  readonly refName: string
}
