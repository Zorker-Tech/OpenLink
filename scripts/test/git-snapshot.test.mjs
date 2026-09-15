import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { collectGitSnapshot, isGitSnapshotArtifactPath } from '../../services/agent-worker/src/git-snapshot.ts'

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
