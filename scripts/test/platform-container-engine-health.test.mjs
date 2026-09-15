import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import { reusableAppleHvProcessSet } from '../../deploy/self-hosted/runtime/platform-container-engine.mjs'

test('a stale AppleHV socket and live-looking pids are not reusable without guest health', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'openlink-platform-health-'))
  const socket = resolve(root, 'podman-api.sock')
  await writeFile(socket, '')
  const previous = { vfkitPid: process.pid, gvproxyPid: process.pid }
  const config = { SSH: { Port: 62123, IdentityPath: resolve(root, 'identity') } }
  try {
    assert.equal(await reusableAppleHvProcessSet(previous, socket, config, async () => {
      throw new Error('guest is unreachable')
    }), false)
    assert.equal(await reusableAppleHvProcessSet(previous, socket, config, async (command, args, options) => {
      assert.equal(command, '/usr/bin/ssh')
      assert.equal(args.at(-1), 'true')
      assert.equal(options.timeout, 5_000)
    }), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
