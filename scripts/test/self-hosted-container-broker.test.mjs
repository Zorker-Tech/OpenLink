import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { requestContainerBroker, serveContainerBroker } from '../../deploy/self-hosted/runtime/container-broker.mjs'

test('container broker exposes only serialized fixed lifecycle actions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-container-broker-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const socket = join(root, 'control.sock')
  const actions = []
  const broker = await serveContainerBroker(socket, async (action) => {
    actions.push(action)
    return { accepted: action }
  })
  t.after(() => broker.close())
  for (const action of ['status', 'start', 'stop']) {
    const response = await requestContainerBroker(socket, action, { timeoutMs: 5_000 })
    assert.equal(response.result.accepted, action)
  }
  assert.deepEqual(actions, ['status', 'start', 'stop'])
  await assert.rejects(requestContainerBroker(socket, 'exec', { timeoutMs: 5_000 }), /not allowed/i)

  const rejected = await new Promise((resolveResponse, rejectResponse) => {
    const client = createConnection(socket)
    let response = ''
    client.setEncoding('utf8')
    client.once('connect', () => client.end(`${JSON.stringify({ schemaVersion: 1, action: 'start', command: 'docker run' })}\n`))
    client.on('data', (chunk) => { response += chunk })
    client.once('error', rejectResponse)
    client.once('end', () => resolveResponse(JSON.parse(response)))
  })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /invalid/i)
  assert.deepEqual(actions, ['status', 'start', 'stop'])

  const multiple = await new Promise((resolveResponse, rejectResponse) => {
    const client = createConnection(socket)
    let response = ''
    client.setEncoding('utf8')
    client.once('connect', () => client.end(`${JSON.stringify({ schemaVersion: 1, action: 'start' })}\n${JSON.stringify({ schemaVersion: 1, action: 'stop' })}\n`))
    client.on('data', (chunk) => { response += chunk })
    client.once('error', rejectResponse)
    client.once('end', () => resolveResponse(JSON.parse(response)))
  })
  assert.equal(multiple.ok, false)
  assert.match(multiple.error, /exactly one/i)
  assert.deepEqual(actions, ['status', 'start', 'stop'])
})

test('container broker never unlinks a non-socket filesystem object', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-container-broker-path-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const socket = join(root, 'control.sock')
  await writeFile(socket, 'operator file\n')
  await assert.rejects(serveContainerBroker(socket, async () => ({})), /refuses to replace a non-socket/i)
  assert.equal(await (await import('node:fs/promises')).readFile(socket, 'utf8'), 'operator file\n')
})
