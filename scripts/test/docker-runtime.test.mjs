import assert from 'node:assert/strict'
import test from 'node:test'
import { isDockerServerVersion } from '../lib/docker-runtime.mjs'

test('Docker readiness accepts only a concrete daemon server version', () => {
  assert.equal(isDockerServerVersion('"29.7.2"\n'), true)
  assert.equal(isDockerServerVersion('29.7.2-desktop.1'), true)
  assert.equal(isDockerServerVersion('Error response from daemon: Docker Desktop is unable to start'), false)
  assert.equal(isDockerServerVersion(''), false)
})
