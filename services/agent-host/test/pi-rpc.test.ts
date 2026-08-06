import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPiRpcCommand, JsonlFrameDecoder } from '../src/pi-rpc.js'

test('builds an argv-only Pi RPC command', () => {
  const command = buildPiRpcCommand({
    entrypoint: '/opt/openlink/pi/dist/rpc-entry.js',
    cwd: '/workspace',
    sessionDir: '/storage/pi-sessions',
    sessionId: 'session-1',
    model: 'anthropic/claude-sonnet',
    environment: { PATH: '/usr/bin' },
  })
  assert.equal(command.executable, 'node')
  assert.equal(command.shell, false)
  assert.deepEqual(command.args.slice(-7), [
    '--session-dir', '/storage/pi-sessions', '--session-id', 'session-1', '--no-approve', '--model', 'anthropic/claude-sonnet',
  ])
  assert.equal(command.env.PATH, '/usr/bin')
  assert.equal(command.env.AI_AGENT, 'pi')
})

test('binds the scoped browser extension without exposing the Browser Host service token', () => {
  const command = buildPiRpcCommand({
    entrypoint: '/opt/openlink/pi/dist/cli.js',
    entrypointKind: 'cli',
    cwd: '/workspace',
    sessionDir: '/storage/pi-sessions',
    sessionId: 'session-browser',
    browser: {
      hostUrl: 'http://127.0.0.1:43120',
      sessionId: 'browser-session',
      controlToken: 'scoped-control-token',
      extensionPath: '/opt/openlink/extensions/openlink-browser.ts',
    },
  })
  assert.deepEqual(command.args.slice(-2), ['--extension', '/opt/openlink/extensions/openlink-browser.ts'])
  assert.equal(command.env.OPENLINK_BROWSER_SESSION_ID, 'browser-session')
  assert.equal(command.env.OPENLINK_BROWSER_CONTROL_TOKEN, 'scoped-control-token')
  assert.equal(command.env.OPENLINK_BROWSER_HOST_URL, 'http://127.0.0.1:43120')
})

test('decodes LF-delimited JSONL and rejects an unfinished frame', () => {
  const decoder = new JsonlFrameDecoder()
  assert.deepEqual(decoder.push('{"type":"message"}\n'), [{ type: 'message' }])
  decoder.push('{"type":"partial"}')
  assert.throws(() => decoder.finish())
})

test('rejects oversized and invalid frames', () => {
  assert.throws(() => new JsonlFrameDecoder(4).push('{"x":1}\n'))
  assert.throws(() => new JsonlFrameDecoder().push('{invalid}\n'))
})
