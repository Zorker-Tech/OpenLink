import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const GIT_PATCH_LIMIT_PER_FILE = 24 * 1024
const GIT_PATCH_LIMIT_TOTAL = 96 * 1024

export interface GitChangedFile {
  path: string
  additions?: number
  deletions?: number
  patch?: string
}

export interface GitSnapshotFrame {
  type: 'openlink_git_snapshot'
  toolCallId: string
  baseCommit: string
  files: GitChangedFile[]
  additions: number
  deletions: number
  signature: string
}

const RUNTIME_DIRECTORY_NAMES = new Set([
  '.agents',
  '.cache',
  '.codex',
  '.local',
  '.openlink',
  '.supabase',
])

/**
 * Runtime state and logs are never project source. This policy is enforced in
 * the Worker collector rather than delegated to a mutable project .gitignore,
 * so tracked logs and freshly-created runtime homes are excluded equally.
 */
export function isGitSnapshotArtifactPath(input: string): boolean {
  const normalized = input.replaceAll('\\', '/').replace(/^\.\//, '')
  const segments = normalized.split('/').filter(Boolean)
  if (!segments.length) return true
  if (segments.some((segment) => RUNTIME_DIRECTORY_NAMES.has(segment))) return true
  const basename = segments.at(-1) ?? ''
  if (/\.log(?:\.[^/]*)?$/i.test(basename)) return true
  if (/^(?:stderr|stdout)(?:[-_.].*)?\.(?:log|txt)$/i.test(basename)) return true
  return false
}

async function runGit(workspaceRoot: string, args: string[], maxBuffer = GIT_PATCH_LIMIT_TOTAL + 16 * 1024, env?: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspaceRoot, ...args], {
      cwd: workspaceRoot,
      maxBuffer,
      windowsHide: true,
      ...(env ? { env } : {}),
    })
    return stdout
  } catch {
    return null
  }
}

function countLines(content: string): number {
  if (!content.length) return 0
  const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content
  return trimmed ? trimmed.split(/\r?\n/).length : 1
}

function untrackedPatch(path: string, content: string): string {
  const lines = content.split(/(?<=\n)/).map((line) => `+${line.endsWith('\n') ? line.slice(0, -1) : line}`)
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${countLines(content)} @@`,
    ...lines,
  ].join('\n')
}

/**
 * Working-tree baseline for one agent turn.
 *
 * `tree` is the Git tree object for the entire working copy at turn start:
 * tracked edits, staged edits, and untracked files. It is written through a
 * throwaway index in the OS temp directory, so capturing a baseline never
 * touches the user's real index, HEAD, or stash. `refresh()` re-hashes the
 * working copy through that same index, reusing Git's stat cache, and returns
 * the tree for the current state.
 */
export interface GitWorkingTreeBaseline {
  tree: string
  refresh(): Promise<string | null>
  dispose(): Promise<void>
}

export async function createGitBaseline(workspaceRoot: string): Promise<GitWorkingTreeBaseline | null> {
  const directory = await mkdtemp(join(tmpdir(), 'openlink-git-baseline-'))
  const env = { ...process.env, GIT_INDEX_FILE: join(directory, 'index') }
  const dispose = async () => { await rm(directory, { recursive: true, force: true }).catch(() => undefined) }
  const seeded = (await runGit(workspaceRoot, ['rev-parse', '--verify', 'HEAD']))
    ? await runGit(workspaceRoot, ['read-tree', 'HEAD'], undefined, env)
    : await runGit(workspaceRoot, ['read-tree', '--empty'], undefined, env)
  if (seeded === null) {
    await dispose()
    return null
  }
  const refresh = async () => {
    if (await runGit(workspaceRoot, ['add', '-A', '--', '.'], undefined, env) === null) return null
    return (await runGit(workspaceRoot, ['write-tree'], undefined, env))?.trim() || null
  }
  const tree = await refresh()
  if (!tree) {
    await dispose()
    return null
  }
  return { tree, refresh, dispose }
}

export async function collectGitSnapshot(workspaceRoot: string, baseline?: GitWorkingTreeBaseline | null): Promise<GitSnapshotFrame | null> {
  const baseCommit = (await runGit(workspaceRoot, ['rev-parse', '--short=12', 'HEAD']))?.trim()
  if (!baseCommit) return null

  // With a turn baseline the snapshot answers "what did this turn change?",
  // which is what Codex and ChatGPT clients show. Without one (baseline capture
  // failed, or an older caller) it falls back to the whole working tree
  // against HEAD.
  const currentTree = baseline ? await baseline.refresh() : null
  if (baseline && !currentTree) return null
  const comparison = baseline && currentTree ? [baseline.tree, currentTree] : ['HEAD']

  const numstat = await runGit(workspaceRoot, ['diff', '--no-ext-diff', '--no-renames', '--numstat', '-z', ...comparison, '--'])
  if (numstat === null) return null
  const stats = new Map<string, { additions?: number; deletions?: number }>()
  for (const entry of numstat.split('\0')) {
    if (!entry) continue
    const [rawAdditions, rawDeletions, path] = entry.split('\t')
    if (!path || isGitSnapshotArtifactPath(path)) continue
    stats.set(path, {
      ...(rawAdditions !== '-' ? { additions: Number(rawAdditions) || 0 } : {}),
      ...(rawDeletions !== '-' ? { deletions: Number(rawDeletions) || 0 } : {}),
    })
  }

  // Untracked files are already part of both tree objects; only the HEAD
  // fallback has to enumerate them separately.
  let untrackedPaths: string[] = []
  if (!currentTree) {
    const untracked = await runGit(workspaceRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
    if (untracked === null) return null
    untrackedPaths = untracked.split('\0').filter((path) => path && !isGitSnapshotArtifactPath(path))
  }
  const untrackedSet = new Set(untrackedPaths)
  const paths = new Set([...stats.keys(), ...untrackedPaths])
  const files: GitChangedFile[] = []
  let remainingPatch = GIT_PATCH_LIMIT_TOTAL

  for (const path of [...paths].sort()) {
    const details = stats.get(path) ?? {}
    const absolutePath = resolve(workspaceRoot, path)
    // Git paths are expected to be workspace-relative. Preserve that boundary
    // even in the presence of a malicious filename from a mounted volume.
    const workspaceRelative = relative(workspaceRoot, absolutePath)
    if (workspaceRelative === '..' || workspaceRelative.startsWith('../')) continue
    let patch = ''
    if (untrackedSet.has(path)) {
      try {
        const source = await readFile(absolutePath)
        if (source.includes(0)) throw new Error('binary file')
        const content = source.toString('utf8')
        patch = untrackedPatch(path, content)
        details.additions = countLines(content)
        details.deletions = 0
      } catch {
        // Directories, binary files, and raced deletions remain visible in the
        // file list without inventing a text diff.
      }
    } else {
      patch = (await runGit(workspaceRoot, ['diff', '--no-ext-diff', '--no-renames', '--unified=3', ...comparison, '--', path], GIT_PATCH_LIMIT_PER_FILE + 4 * 1024)) ?? ''
    }
    const boundedPatch = patch.slice(0, Math.max(0, Math.min(GIT_PATCH_LIMIT_PER_FILE, remainingPatch)))
    remainingPatch -= boundedPatch.length
    files.push({ path, ...details, ...(boundedPatch ? { patch: boundedPatch } : {}) })
  }

  const additions = files.reduce((total, file) => total + (file.additions ?? 0), 0)
  const deletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0)
  return {
    type: 'openlink_git_snapshot',
    toolCallId: '',
    baseCommit,
    files,
    additions,
    deletions,
    signature: JSON.stringify({ baseCommit, files }),
  }
}
