import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parseEnvironmentFile, runPreflight } from '../../deploy/self-hosted/runtime/preflight.mjs'

test('environment parser accepts literals and rejects shell evaluation syntax', () => {
  assert.deepEqual(parseEnvironmentFile('A=value\nB="two words"\n# ignored\n'), { A: 'value', B: 'two words' })
  assert.throws(() => parseEnvironmentFile('A=$(id)\n'), /shell|unsafe/i)
  assert.throws(() => parseEnvironmentFile('A=one\nA=two\n'), /duplicate/i)
  assert.throws(() => parseEnvironmentFile('NEXT_PUBLIC_SECRET_KEY=bad\n'), /public.*secret/i)
})

test('fixture preflight enforces immutable runtime inputs without requiring build tools', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-preflight-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const releaseRoot = join(root, 'release')
  const stateRoot = join(root, 'state')
  for (const relative of [
    'runtime/node/bin/node',
    'app/web/server.js',
    'services/agent-host/dist/src/main.js',
    'services/agent-host/dist/src/project-container-main.js',
    'services/agent-host/project-supabase-runtime.mjs',
    'scripts/lib/project-supabase-bundle.mjs',
    'services/browser-host/dist/src/main.js',
    'services/knowledge-service/dist/src/main.js',
    'services/agent-host/dist/src/desktop-main.js',
    'images/runtime/manifest.json',
    'images/zokerbase/manifest.json',
    'images/zero/manifest.json',
    'toolchain/bin/podman',
    'edge/bin/caddy',
    'edge/Caddyfile',
    'browser/manifest.json',
    'browser/chromium/chrome',
    'project-vm/manifest.json',
    'project-supabase/manifest.json',
    'project-supabase/runtime.lock.json',
    'project-supabase/runtime.spec.json',
    'project-supabase/image-manifest.json',
    'project-supabase/release-trust.json',
    'orchestration/docker-compose.production.yml',
    'orchestration/docker-compose.zero-production.yml',
    'systemd/openlink.service',
    'systemd/openlink-container-broker.service',
    'systemd/openlink-project-container-broker.service',
  ]) {
    const path = join(releaseRoot, ...relative.split('/'))
    await mkdir(join(path, '..'), { recursive: true })
    const contents = relative === 'browser/manifest.json'
      ? `${JSON.stringify({ target: process.platform === 'linux' && process.arch === 'x64' ? 'linux-amd64' : `${process.platform}-${process.arch}`, executable: 'chromium/chrome' })}\n`
      : relative.endsWith('.json') ? '{}\n' : 'fixture\n'
    await writeFile(path, contents, { mode: relative.includes('/bin/') || relative === 'browser/chromium/chrome' ? 0o755 : 0o644 })
  }
  const result = await runPreflight({
    releaseRoot,
    stateRoot,
    platform: process.platform,
    architecture: process.arch,
    hostChecks: false,
    minimumFreeBytes: 1,
    minimumMemoryBytes: 1,
  })
  assert.equal(result.ok, true)
  assert.equal(result.checks.every((check) => check.status === 'pass'), true)
  await (await import('node:fs/promises')).rm(join(releaseRoot, 'app/web/server.js'))
  await assert.rejects(runPreflight({
    releaseRoot,
    stateRoot,
    platform: process.platform,
    architecture: process.arch,
    hostChecks: false,
    minimumFreeBytes: 1,
    minimumMemoryBytes: 1,
  }), /missing.*app\/web\/server\.js/i)
})

test('customer runtime source contains no build or dependency-install execution', async () => {
  const sources = await Promise.all([
    new URL('../../deploy/self-hosted/openlinkctl.mjs', import.meta.url),
    new URL('../../deploy/self-hosted/bootstrap-installer.mjs', import.meta.url),
    new URL('../../deploy/self-hosted/runtime/preflight.mjs', import.meta.url),
    new URL('../../deploy/self-hosted/runtime/configuration.mjs', import.meta.url),
    new URL('../../deploy/self-hosted/runtime/production-runtime.mjs', import.meta.url),
    new URL('../../deploy/self-hosted/runtime/lifecycle-lock.mjs', import.meta.url),
    new URL('../../deploy/self-hosted/runtime/backup.mjs', import.meta.url),
    new URL('../../deploy/self-hosted/runtime/upgrade.mjs', import.meta.url),
  ].map((url) => (import('node:fs/promises')).then(({ readFile }) => readFile(url, 'utf8'))))
  const executableBuild = /(?:spawn|execFile|runCommand)[\s\S]{0,180}['"](?:npm|pnpm|yarn|next|tsc|go|docker|podman)['"][\s\S]{0,100}['"](?:install|ci|build|pull)['"]/i
  for (const source of sources) assert.doesNotMatch(source, executableBuild)
})
