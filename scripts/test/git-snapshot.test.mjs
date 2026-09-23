import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { createGitBaseline, collectGitSnapshot, isGitSnapshotArtifactPath } from '../../services/agent-worker/src/git-snapshot.ts'

const execFileAsync = promisify(execFile)

test('classifies Worker runtime homes and logs as non-project artifacts', () => {
  for (const path of ['.local/share/code-server/coder-logs/code-server-stderr.log', '.openlink/runtime.json', '.supabase/state', 'logs/debug.log.1', 'server.log']) {
    assert.equal(isGitSnapshotArtifactPath(path), true, path)
  }
  for (const path of ['src/logger.ts', 'docs/logging.md', 'public/catalog.json']) {
    assert.equal(isGitSnapshotArtifactPath(path), false, path)
  }
})

test('collects source changes while excluding tracked and untracked runtime logs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-git-snapshot-'))
  try {
    await execFileAsync('git', ['init', '-q'], { cwd: root })
    await execFileAsync('git', ['config', 'user.name', 'OpenLink Test'], { cwd: root })
    await execFileAsync('git', ['config', 'user.email', 'test@openlink.local'], { cwd: root })
    await writeFile(join(root, 'README.md'), 'baseline\n')
    await writeFile(join(root, 'tracked.log'), 'old log\n')
    await execFileAsync('git', ['add', 'README.md', 'tracked.log'], { cwd: root })
    await execFileAsync('git', ['commit', '-qm', 'baseline'], { cwd: root })

    await writeFile(join(root, 'README.md'), 'baseline\nreal change\n')
    await writeFile(join(root, 'tracked.log'), 'new log\n')
    await writeFile(join(root, 'worker.log'), 'runtime noise\n')
    await mkdir(join(root, '.local', 'share'), { recursive: true })
    await writeFile(join(root, '.local', 'share', 'runtime.json'), '{}\n')
    await mkdir(join(root, '.openlink'), { recursive: true })
    await writeFile(join(root, '.openlink', 'state.json'), '{}\n')

    const snapshot = await collectGitSnapshot(root)
    assert.ok(snapshot)
    assert.deepEqual(snapshot.files.map((file) => file.path), ['README.md'])
    assert.equal(snapshot.additions, 1)
    assert.equal(snapshot.deletions, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('baseline snapshots report only the current turn and stay empty for untouched trees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-git-baseline-'))
  try {
    await execFileAsync('git', ['init', '-q'], { cwd: root })
    await execFileAsync('git', ['config', 'user.name', 'OpenLink Test'], { cwd: root })
    await execFileAsync('git', ['config', 'user.email', 'test@openlink.local'], { cwd: root })
    await writeFile(join(root, 'README.md'), 'baseline\n')
    await execFileAsync('git', ['add', 'README.md'], { cwd: root })
    await execFileAsync('git', ['commit', '-qm', 'baseline'], { cwd: root })

    // A previous session left uncommitted work behind. It must not be
    // attributed to the turn that starts now.
    await writeFile(join(root, 'legacy.ts'), 'export const legacy = true\n')
    await writeFile(join(root, 'README.md'), 'baseline\nprevious session edit\n')

    const baseline = await createGitBaseline(root)
    assert.ok(baseline)
    const untouched = await collectGitSnapshot(root, baseline)
    assert.ok(untouched)
    assert.deepEqual(untouched.files, [])

    // The turn edits one file, then reverts. The tree moves back to the
    // baseline, so no change may be reported for the turn.
    await writeFile(join(root, 'feature.ts'), 'export const feature = true\n')
    const changed = await collectGitSnapshot(root, baseline)
    assert.ok(changed)
    assert.deepEqual(changed.files.map((file) => file.path), ['feature.ts'])
    assert.equal(changed.additions, 1)

    await rm(join(root, 'feature.ts'))
    const reverted = await collectGitSnapshot(root, baseline)
    assert.ok(reverted)
    assert.deepEqual(reverted.files, [])

    // The legacy fallback still describes the whole working tree vs HEAD.
    const legacy = await collectGitSnapshot(root)
    assert.ok(legacy)
    assert.deepEqual(legacy.files.map((file) => file.path), ['README.md', 'legacy.ts'])
    await baseline.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
