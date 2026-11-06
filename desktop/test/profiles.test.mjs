import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  createProfileStore,
  parseProfileUrl,
  validateProfile,
} from '../src/main/profiles.mjs'

test('parseProfileUrl normalizes origins and rejects unsafe URLs', () => {
  assert.equal(parseProfileUrl('https://openlink.example.com/'), 'https://openlink.example.com')
  assert.equal(parseProfileUrl('http://127.0.0.1:3000/base/'), 'http://127.0.0.1:3000/base')
  assert.throws(() => parseProfileUrl('ftp://openlink.example.com'), /HTTP or HTTPS/)
  assert.throws(() => parseProfileUrl('https://user:pass@openlink.example.com'), /credentials/)
  assert.throws(() => parseProfileUrl('not a url'), /invalid/)
})

test('validateProfile accepts Cloud and self-hosted servers only', () => {
  const remote = validateProfile({ kind: 'remote', upstreamUrl: 'https://openlink.example.com/' })
  assert.equal(remote.kind, 'remote')
  assert.equal(remote.upstreamUrl, 'https://openlink.example.com')
  assert.equal(remote.name, 'Remote')

  const cloud = validateProfile({ kind: 'cloud', name: 'Production', upstreamUrl: 'https://cloud.example.com' })
  assert.equal(cloud.kind, 'cloud')
  assert.equal(cloud.name, 'Production')

  // There is no desktop-managed local runtime: localhost is a normal remote
  // server that the user installs and operates separately.
  const localhost = validateProfile({ kind: 'remote', upstreamUrl: 'http://127.0.0.1:3000' })
  assert.equal(localhost.upstreamUrl, 'http://127.0.0.1:3000')
  assert.throws(() => validateProfile({ kind: 'local', upstreamUrl: 'http://127.0.0.1:3000' }), /cloud or remote/)
  assert.throws(() => validateProfile({ kind: 'remote' }), /URL is required/)
  assert.throws(() => validateProfile({ kind: 'nope' }), /kind must be/)
  assert.throws(() => validateProfile(null), /profile object/)
})

test('profile store persists, activates, updates, and removes profiles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openlink-profiles-'))
  const filePath = join(directory, 'profiles.json')
  try {
    const store = createProfileStore({
      filePath,
      defaultProfile: {
        id: 'remote-default',
        kind: 'remote',
        name: 'Local server',
        upstreamUrl: 'http://127.0.0.1:3000',
      },
    })
    await store.load()
    assert.equal(store.active()?.id, 'remote-default')

    const cloud = await store.upsert({
      kind: 'cloud',
      name: 'Production',
      upstreamUrl: 'https://cloud.example.com',
      gatewayPort: 43130,
    })
    assert.ok(cloud.id)
    assert.equal(store.list().length, 2)

    await store.setActive(cloud.id)
    assert.equal(store.active()?.id, cloud.id)

    const updated = await store.upsert({ ...cloud, name: 'Production 2' })
    assert.equal(updated.name, 'Production 2')
    assert.equal(store.list().length, 2)

    const reloaded = createProfileStore({ filePath })
    await reloaded.load()
    assert.equal(reloaded.active()?.name, 'Production 2')
    assert.equal(reloaded.list().length, 2)

    assert.equal(await store.remove(cloud.id), true)
    assert.equal(store.active()?.id, 'remote-default')
    assert.equal(await store.remove('missing'), false)

    const contents = JSON.parse(await readFile(filePath, 'utf8'))
    assert.equal(contents.version, 1)
    assert.equal(contents.profiles.length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
