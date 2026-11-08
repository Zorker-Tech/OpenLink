import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { isPreviewSourceRevision } from '@openlink/browser-protocol'
import { PREVIEW_SOURCE_REVISION_SCRIPT } from '../src/project-runtime.js'

test('Preview source revisions track committed and dirty source while safely handling hostile paths', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'openlink-preview-source-revision-'))
  const marker = join(parent, 'shell-injection-ran')
  const workspace = join(parent, `checkout ; $(touch ${marker}) 'quoted'`)
  await mkdir(join(workspace, 'src'), { recursive: true })
  t.after(() => rm(parent, { recursive: true, force: true }))

  const git = (...args: string[]) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim()
  await writeFile(join(workspace, '.gitignore'), 'ignored/\n')
  await writeFile(join(workspace, 'src', 'app.ts'), 'export const value = "baseline"\n')
  git('init', '--initial-branch=main')
  git('config', 'user.name', 'Preview Revision Test')
  git('config', 'user.email', 'preview-revision@example.invalid')
  git('add', '--all')
  git('commit', '--no-gpg-sign', '-m', 'baseline')

  const revision = () => execFileSync('bash', [
    '-lc', PREVIEW_SOURCE_REVISION_SCRIPT, 'openlink-preview-source-revision', workspace,
  ], { encoding: 'utf8' }).trim()

  const baseline = revision()
  assert.ok(isPreviewSourceRevision(baseline))
  assert.equal(revision(), baseline, 'an unchanged checkout must have a stable revision')
  assert.equal(existsSync(marker), false, 'workspace path data must never be evaluated as shell code')

  await mkdir(join(workspace, 'ignored'))
  await writeFile(join(workspace, 'ignored', 'generated.txt'), 'ignored output')
  assert.equal(revision(), baseline, 'ignored build output must not invalidate source identity')

  const tracked = join(workspace, 'src', 'app.ts')
  await writeFile(tracked, 'export const value = "unstaged"\n')
  const unstaged = revision()
  assert.notEqual(unstaged, baseline, 'unstaged tracked edits must change the revision')
  git('add', '--', 'src/app.ts')
  assert.equal(revision(), unstaged, 'staging the same working-tree content must not create a false revision')

  await writeFile(tracked, 'export const value = "staged plus unstaged"\n')
  const stagedAndUnstaged = revision()
  assert.notEqual(stagedAndUnstaged, unstaged, 'the index and worktree together define source state')

  const unusualPath = join(workspace, '-line\nbreak.txt')
  await writeFile(unusualPath, 'untracked source')
  const untracked = revision()
  assert.notEqual(untracked, stagedAndUnstaged, 'untracked source files must be included')
  await writeFile(unusualPath, 'changed untracked source')
  const changedUntracked = revision()
  assert.notEqual(changedUntracked, untracked, 'untracked file contents must be included')
  await chmod(unusualPath, 0o755)
  const executableUntracked = revision()
  assert.notEqual(executableUntracked, changedUntracked, 'untracked file mode must be included')

  await rm(unusualPath)
  assert.notEqual(revision(), executableUntracked, 'removing an untracked file must change the revision')
  await rm(tracked)
  assert.notEqual(revision(), stagedAndUnstaged, 'tracked deletions must be included')
  assert.equal(existsSync(marker), false)
})
